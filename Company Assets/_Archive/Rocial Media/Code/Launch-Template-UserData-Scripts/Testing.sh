#!/bin/bash

# Define environment variable for the instance (e.g., development, testing, production)
export ENVIRONMENT=testing

# Update the instance and install necessary packages using yum for Amazon Linux
sudo yum update -y
sudo yum install -y nginx git python3 python3-pip

# Check and install AWS CLI if not already installed
if ! command -v aws &> /dev/null
then
    echo "AWS CLI not found, installing..."
    sudo yum install -y aws-cli
fi

# Clone your GitHub repository (replace with your actual repository)
cd ~ 
git clone https://github.com/RoDarkStudios/rocial-media.git

# Install Python dependencies globally
cd ~/rocial-media
pip3 install -r requirements.txt

# Install gunicorn globally
pip3 install gunicorn

# Calculate the number of Gunicorn workers dynamically based on the CPU core count
NUM_CORES=$(nproc)
GUNICORN_WORKERS=$((2 * NUM_CORES + 1))

# Configure Gunicorn as a systemd service with dynamic worker count
sudo tee /etc/systemd/system/gunicorn.service > /dev/null <<EOF
[Unit]
Description=Gunicorn instance to serve Rocial Media
After=network.target

[Service]
User=ec2-user  # Using ec2-user for Amazon Linux
Group=nginx
WorkingDirectory=~/rocial-media
ExecStart=/usr/local/bin/gunicorn --workers $GUNICORN_WORKERS --bind 0.0.0.0:8000 main:app

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and start Gunicorn
sudo systemctl daemon-reload
sudo systemctl start gunicorn
sudo systemctl enable gunicorn

# Get load balancer DNS
# 1. Retrieve the EC2 Instance ID using the metadata service
INSTANCE_ID=$(curl http://169.254.169.254/latest/meta-data/instance-id)

# 2. Set the AWS Region
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

# 3. Get the Target Group ARN associated with this EC2 instance
TARGET_GROUP_ARN=$(aws elbv2 describe-target-health --region $REGION --targets Id=$INSTANCE_ID \
  --query "TargetHealthDescriptions[0].TargetGroupArn" --output text)

# 4. Retrieve the Load Balancer ARN associated with the Target Group
LOAD_BALANCER_ARN=$(aws elbv2 describe-target-groups --target-group-arns $TARGET_GROUP_ARN \
  --region $REGION --query "TargetGroups[0].LoadBalancerArns[0]" --output text)

# 5. Get the Load Balancer DNS Name
ELB_DNS=$(aws elbv2 describe-load-balancers --region $REGION --load-balancer-arns $LOAD_BALANCER_ARN \
  --query "LoadBalancers[0].DNSName" --output text)

# Configure Nginx as a reverse proxy for Gunicorn
sudo tee /etc/nginx/conf.d/main.conf > /dev/null <<EOF
server {
    listen 80;
    server_name $ELB_DNS;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /static/ {
        alias ~/rocial-media/static/;
    }
}
EOF

# Start and enable Nginx
sudo systemctl restart nginx
sudo systemctl enable nginx

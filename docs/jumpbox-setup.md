# Provisioning PgBouncer on an EC2 instance

## Launch an EC2 Instance

The choices we used when launching an instance:

```
AMI - latest Ubuntu LTS:
  Ubuntu Server 24.04 LTS (HVM), SSD Volume Type

Architecture - thd default 64-bit (x86)
  x86_64

Instance type
  m5.xlarge

Key pair - up to you

Network settings
  VPC - Your Medplum cluster's VPC
    "Medplum<Name>/BackEnd/VPC

  Subnet - The public subnet collocated with your RDS writer node's AZ, e.g. us-west2a

  Auto-assign public IP - Enable since this is a jumpbox

  Firewall (security groups)
    Create a new "jumpbox" security group
    Inbound Security Group Rules: Add SSH w/ "My IP" as source type
```

## Server setup

Update packages and install psql, make, [nvm](https://github.com/nvm-sh/nvm?tab=readme-ov-file#install--update-script), and [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/#debianubuntu).

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y postgresql-client-16 make

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6

touch ~/.pgpass
chmod 600 ~/.pgpass

sudo reboot
```

Reconnect after the server reboots; usually takes just a few seconds.

Specify database usernames and passwords in `~/.pgpass`; a well-known file
used by `psql` and other postgres clients for sourcing database credentials:

```
*:5432:medplum:<username>:<password>
*:5432:green:<username>:<password>
*:5432:blue:<username>:<password>
*:5432:pgbouncer:pgbouncer_admin:<pgbouncer_admin-password>
```

Install NodeJS, clone this repository, install dependencies,
and set database connection details:

```bash
git clone https://github.com/medplum/medplum-postgres-upgrade.git
cd medplum-postgres-upgrade
nvm install v22
npm ci

cp db.config.template.json db.config.json
echo "Please specify database connection details in db.config.json AND Makefile"
```

Verify postgres connectivity by attempting to connect to your blue, green , and
PbBouncer databases. You can also safely run the switchover script (it runs in dry run
mode by default) to further verify connectivity and start verifying switchover preconditions
if appropriate:

```bash
make psql-blue
make psql-green
make psql-proxy
make psql-pgbouncer

npm run switch
```

# Provisioning PgBouncer on an EC2 instance

## Launch an EC2 Instance

The choices we used when launching an instance:

```
AMI - latest Ubuntu LTS:
  Ubuntu Server 24.04 LTS (HVM), SSD Volume Type

Architecture - thd default 64-bit (x86)
  x86_64

Instance type - current generation general purpose, e.g. m5. Network bandwidth is most important. Err on the side of over-provisioning.
  m5.2xlarge

Key pair - up to you

Network settings
  VPC - Your Medplum cluster's VPC
    "Medplum<Name>/BackEnd/VPC

  Subnet - Collocated with your RDS writer node's AZ, e.g. us-west2a

  Auto-assign public IP - Should NOT have a Public IP since it's in private subnet
    Disable

  Firewall (security groups)
    Select existing security group

  Common security groups
    Medplum<Name>-BackEndDatabaseClusterSecurityGroup - same security group as RDS nodes
    <SomeSGAllowingSSH> - Ideally limited to a bastion/jumpbox
```

## Server setup

Update packages and install pgbouncer. Note that a somewhat outdated version of PgBouncer is available
in the default Ubuntu apt repositories.

```
sudo apt update
sudo apt upgrade -y
sudo apt install -y pgbouncer
```

### Create self-signed certificate

This step is only necessary if you want to allow and or require clients to connect to PgBouncer
using SSL. If you do opt to use a self-signed certificate, you must ensure Postgres clients set
`rejectUnauthorized` to `false` or otherwise disable CA verification.

```
cd /etc/pgbouncer

# generate private key for accepting client connections
# requires a passphrase to be entered (write it down somewhere just incase)
sudo openssl genrsa -des3 -out server.key 2048

# removes the passphrase
sudo openssl rsa -in server.key -out server.key

# generate a certificate for the private key
sudo openssl req -new -key server.key -days 3650 -out server.crt -x509 -subj '/C=US/ST=California/L=San Francisco/O=Medplum/CN=foobar'

# lock down permissions
sudo chown postgres:postgres server.*
sudo chmod 600 server.key
sudo chmod 644 server.crt
```

### Configure PgBouncer

Create the file `/etc/pgbouncer/blue.pgbouncer.ini` with the following contents:

```
[databases]
medplum = pool_mode=transaction pool_size=1000 dbname=medplum host=<BLUE-rds-cluster-endpoint-goes-here>
green   = pool_mode=transaction pool_size=1000 dbname=medplum host=<GREEN-rds-cluster-endpoint-goes-here>

[pgbouncer]
# A good starting point is to match your database's `max_connections`.
# The RDS postgres default formula is LEAST({DBInstanceClassMemory/9531392},5000)
# Your current value can be determined with `SHOW max_connections;`
# From the PgBouncer docs: When this setting is increased, then the file descriptor limits in the operating system
# might also have to be increased. https://www.pgbouncer.org/config.html
max_client_conn = 400

logfile = /var/log/postgresql/pgbouncer.log
pidfile = /var/run/postgresql/pgbouncer.pid
unix_socket_dir = /var/run/postgresql

listen_addr = *
listen_port = 5432

client_tls_sslmode = require
client_tls_key_file = /etc/pgbouncer/server.key
client_tls_cert_file = /etc/pgbouncer/server.crt

auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt
admin_users = pgbouncer_admin
```

Create the file `/etc/pgbouncer/green.pgbouncer.ini` with the same contents as `blue.pgbouncer.ini`
except replace the `[databases]` section with the following:

```
[databases]
blue    = pool_mode=transaction pool_size=1000 dbname=medplum host=<BLUE-rds-cluster-endpoint-goes-here>
medplum = pool_mode=transaction pool_size=1000 dbname=medplum host=<GREEN-rds-cluster-endpoint-goes-here>
```

Create/update the file `/etc/pgbouncer/userlist.txt` with contents similar to that shown below. In addition
to the user that connects to the Medplum database, specify another user `pgbouncer_admin` that will have
admin access to PgBouncer. You should use a strong password for the `pgbouncer_admin` user.

```
"medplum" "md5<md5(password + username)>"
"pgbouncer_admin" "md5<md5(password + username)>"
```

### Avoiding storing passwords in plaintext

To avoid storing passwords in plaintext, use the md5 postgres password format: the characters `md5`
followed by the md5 sum of the password and username concatenated. One way to securely generate these hashes without
entering your password as a command-line argument is to first create a file, e.g. `mypassword.txt`, that contains your
password and username with no spaces or other delimiters between them. For example, for the username `medplum`
and the password is `12345`, the contents of `mypassword.txt` should be `12345medplum`. Then run the following
command:

```
echo -n "md5"; printf %s "$(cat mypassword.txt)" | md5sum | awk '{print $1}'; rm mypassword.txt
```

The output for the `medplum` and `12345` combination should be `md5f740f98ed462f2f7af7a677b685be54c`. Note the
above command deletes the file containing the plaintext password to cleanup after itself. Repeat as necessary
for each username/password combination.

### Create symlinks and update permissions

Create a symlink from our blue config to `/etc/pgbouncer/pgbouncer.ini`, set some permissions, and reload PgBouncer:

```
cd /etc/pgbouncer
sudo mv pgbouncer.ini default.pgbouncer.ini
sudo chown postgres:postgres blue.pgbouncer.ini green.pgbouncer.ini userlist.txt
sudo chmod 640 blue.pgbouncer.ini green.pgbouncer.ini userlist.txt
sudo ln -s blue.pgbouncer.ini pgbouncer.ini

# the only time we want to `restart` instead of `reload` since the port pgbouncer listens on changed from 6432 to 5432
sudo service pgbouncer restart
```

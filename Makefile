psql-blue:
	psql -p 5432 -U <username> -h <blue-database-host> medplum

psql-green:
	psql -p 5432 -U <username> -h <green-database-host> medplum

psql-proxy:
	psql --set=sslmode=require -p 5432 -h <pgbouncer-host> -U <username> medplum

psql-proxy-blue:
	psql --set=sslmode=require -p 5432 -h <pgbouncer-host> -U <username> blue

psql-proxy-green:
	psql --set=sslmode=require -p 5432 -h <pgbouncer-host> -U <username> green

psql-pgbouncer:
	psql --set=sslmode=require -p 5432 -h <pgbouncer-host> -U pgbouncer_admin pgbouncer

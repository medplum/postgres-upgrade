#!/usr/bin/env bash

db_instance_name=$1
echo "Searching logs for initial LSN of DB $db_instance_name..."
for logfileName in $(aws rds describe-db-log-files --db-instance-identifier $db_instance_name --query DescribeDBLogFiles[*].LogFileName --output text);
do
       aws rds download-db-log-file-portion --db-instance-identifier $db_instance_name  --log-file-name ${logfileName} --output text | egrep -i "redo (starts|done)"
done

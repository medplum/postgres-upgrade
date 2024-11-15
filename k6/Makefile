DATE := $(shell date +"%Y-%m-%d-%H%M%S")
export K6_WEB_DASHBOARD := true

.PHONY: test constant stress
test:
	k6 run -u 1 -d 3s create.js

constant: export K6_WEB_DASHBOARD_EXPORT := constant-${DATE}.html
constant:
	k6 run --out csv=constant-${DATE}.csv constant.js

stress: export K6_WEB_DASHBOARD_EXPORT := stress-${DATE}.html
stress:
	k6 run --out csv=stress-${DATE}.csv stress.js

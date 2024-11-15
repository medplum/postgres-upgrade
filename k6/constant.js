import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const baseUrl = (__ENV.BASE_URL || 'http://localhost:8103') + '/fhir/R4';
const accessToken = __ENV.ACCESS_TOKEN;
const DURATION = __ENV.DURATION || '30m';

const commonOpts = {};

export const options = {
  scenarios: {
    create_comms: {
      ...commonOpts,
      executor: 'constant-arrival-rate',
      exec: 'createComm',
      duration: DURATION,
      rate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
    long_txns: {
      ...commonOpts,
      exec: 'longTxns',
      duration: DURATION,
      executor: 'constant-vus',
      vus: 5,

      // executor: 'ramping-vus',
      // startVUs: 0,
      // stages: [
      // { duration: '10s', target: 5 },
      // { duration: DURATION, target: 5 },
      // ],
      // gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'http_reqs{status:200}': ['count>=0'],
    'http_reqs{status:201}': ['count>=0'],
    'http_reqs{status:400}': ['count>=0'],
    'http_reqs{status:401}': ['count>=0'],
    'http_reqs{status:403}': ['count>=0'],
    'http_reqs{status:404}': ['count>=0'],
    'http_reqs{method:POST}': ['count>=0'],
  },
  summaryTrendStats: ['min', 'med', 'avg', 'p(90)', 'p(95)', 'max', 'count'],
};

const communication = {
  resourceType: 'Communication',
  status: 'completed',

  identifier: [{ system: 'http://constant.com' }],
  category: [
    {
      coding: [{ system: 'http://example.com/commcat', code: 'sms' }],
    },
  ],
  medium: [
    {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode', code: 'WRITTEN' }],
    },
  ],
  subject: { reference: 'Patient/11111111-1111-4111-1111-111111111111' },
};

export function createComm() {
  sleep(Math.random() * 0.25);

  const value = exec.instance.iterationsCompleted.toString();
  communication.identifier[0].value = value;
  const res = http.post(baseUrl + '/Communication', JSON.stringify(communication), {
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/fhir+json' },
    responseType: 'text',
  });

  if (res.status !== 201) {
    console.error(res.body);
  }

  check(res, {
    'has 201 status': (r) => r.status === 201,
  });
}

const DURATIONS = [2000 /*, 2000, 2000, 4000*/];
export function longTxns() {
  sleep(Math.random() * 0.5);
  const duration = randomElement(DURATIONS);
  const res = http.post(baseUrl + `/$pg-sleep?duration=${duration}`, '{}', {
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    responseType: 'text',
  });

  check(res, {
    'has 200 status': (r) => r.status === 200,
  });
}

function randomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

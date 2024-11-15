import { check, sleep } from 'k6';
import http from 'k6/http';

const baseUrl = (__ENV.BASE_URL || 'http://localhost:8103') + '/fhir/R4';
const accessToken = __ENV.ACCESS_TOKEN;
const DURATION = __ENV.DURATION || '30m';

const commonOpts = {};

export const options = {
  scenarios: {
    create_comms: {
      ...commonOpts,
      executor: 'ramping-vus',
      exec: 'createComm',
      stages: [
        { duration: '5m', target: 200 },
        { duration: DURATION, target: 200 },
        { duration: '5m', target: 0 },
      ],
    },
    create_patient: {
      ...commonOpts,
      executor: 'ramping-vus',
      exec: 'createPatient',
      stages: [
        { duration: '5m', target: 100 },
        { duration: DURATION, target: 100 },
        { duration: '5m', target: 0 },
      ],
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

const patient = JSON.stringify({
  resourceType: 'Patient',
  name: [{ given: ['Homer'], family: 'Simpson' }],
  identifier: [{ system: 'https://healthgorilla.com', value: '12345678' }],
});

export function createPatient() {
  sleep(Math.random() * 0.25);

  const res = http.post(baseUrl + '/Patient', patient, {
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/fhir+json' },
    responseType: 'text',
  });

  check(res, {
    'has 201 status': (r) => r.status === 201,
  });
}

const communication = JSON.stringify({
  resourceType: 'Communication',
  status: 'completed',
  category: [
    {
      coding: [{ system: 'http://example.com/commcat', code: 'sms' }],
    },
  ],
  sent: '2024-09-20',
  medium: [
    {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode', code: 'WRITTEN' }],
    },
  ],
  subject: { reference: 'Patient/6082d735-8fdb-48ca-9ca0-5463d006c11e' },
});

export function createComm() {
  sleep(Math.random() * 0.25);

  const res = http.post(baseUrl + '/Communication', communication, {
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/fhir+json' },
    responseType: 'text',
  });

  check(res, {
    'has 201 status': (r) => r.status === 201,
  });
}

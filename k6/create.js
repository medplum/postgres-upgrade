import { sleep, check } from 'k6';
import http from 'k6/http';

const baseUrl = (__ENV.BASE_URL || 'http://localhost:8103') + '/fhir/R4';
const accessToken = __ENV.ACCESS_TOKEN;

export const options = {
  vus: 1,
  iterations: 10,
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
  subject: { reference: 'Patient/11111111-1111-4111-1111-111111111111' },
});

export default function () {
  sleep(0.5);

  const res = http.post(baseUrl + '/Communication', communication, {
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/fhir+json' },
    responseType: 'text',
  });
  const result = check(res, {
    'has 201 status': (r) => r.status === 201,
  });
}

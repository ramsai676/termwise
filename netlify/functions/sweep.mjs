// Hourly: delete demo workspaces past their 24 hour expiry.
import { getStore } from '@netlify/blobs';
import { Service } from '../../lib/service.js';
import { BlobStore } from '../../lib/store/index.js';

export default async () => {
  const svc = new Service(new BlobStore(getStore({ name: 'termwise', consistency: 'strong' })));
  const swept = await svc.sweepDemos();
  console.log(`swept ${swept} expired demo workspaces`);
};

export const config = { schedule: '@hourly' };

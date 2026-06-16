// Bootstrap for single-agent smoke scripts. Logs in (embedded user) and
// populates TEST_* for the running bot as LEAD (self by default). No worker.
// Override: SMOKE_USER, SMOKE_LEAD.
import { applyEnv } from './smoke-config.js';
await applyEnv({ needWorker: false });

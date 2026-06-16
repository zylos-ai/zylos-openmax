// Bootstrap for multi-agent smoke scripts. Logs in (embedded user) and
// populates TEST_* for LEAD (self by default) + a caller-specified WORKER.
// Override: SMOKE_USER, SMOKE_LEAD, SMOKE_WORKER (default agent-gavin3).
import { applyEnv } from './smoke-config.js';
await applyEnv({ needWorker: true });

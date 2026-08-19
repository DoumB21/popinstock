const SUPABASE_URL      = 'https://otzyszbbsuwoxupbpfju.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90enlzemJic3V3b3h1cGJwZmp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NDU5ODMsImV4cCI6MjA5MDMyMTk4M30.s8XzcbpZ2PCwOvXJcN7LqPKhqyZop_hdUOFdvLbPCWU';
const IPFS_GATEWAY      = 'https://gateway.pinata.cloud/ipfs/';

// Single source of truth for IPFS gateway fallback order — public gateways don't
// all have the same peers/cache, so pages cycle through these on image load error
// instead of retrying the same one. Was hand-copied into every page; edit here only.
// IPFS_GATEWAY_LIST[0] must stay equal to IPFS_GATEWAY — several pages' onerror
// handlers start their retry loop at index 1, assuming index 0 is the gateway the
// initial (non-fallback) image load already tried and failed.
const IPFS_GATEWAY_LIST = [IPFS_GATEWAY, 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/'];

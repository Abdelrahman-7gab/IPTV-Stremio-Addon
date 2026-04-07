const { createClient } = require('@supabase/supabase-js');

function readRequiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required for Supabase snapshot mode`);
    }
    return value;
}

function getSupabaseUrl() {
    return readRequiredEnv('SUPABASE_URL');
}

function getSupabasePublishableKey() {
    return process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
}

function getSupabaseServiceRoleKey() {
    return readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
}

let serviceRoleClient = null;

function getServiceSupabase() {
    if (!serviceRoleClient) {
        serviceRoleClient = createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
    }
    return serviceRoleClient;
}

function getPublicSupabaseConfig() {
    const publishableKey = getSupabasePublishableKey();
    if (!publishableKey) {
        throw new Error('SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY is required for browser auth');
    }

    return {
        url: getSupabaseUrl(),
        publishableKey
    };
}

module.exports = {
    getPublicSupabaseConfig,
    getServiceSupabase,
    getSupabaseUrl
};

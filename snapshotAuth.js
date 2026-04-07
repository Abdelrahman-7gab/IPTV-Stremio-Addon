const { getServiceSupabase } = require('./supabaseClient');

class SnapshotAuthError extends Error {
    constructor(statusCode, code, message) {
        super(message);
        this.name = 'SnapshotAuthError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

function readBearerToken(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || typeof authHeader !== 'string') return '';

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function authenticateSupabaseUser(req) {
    const accessToken = readBearerToken(req);
    if (!accessToken) {
        throw new SnapshotAuthError(401, 'missing_auth', 'Missing Supabase bearer token');
    }

    const supabase = getServiceSupabase();
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data?.user) {
        throw new SnapshotAuthError(401, 'invalid_auth', 'Supabase session is invalid or expired');
    }

    const email = String(data.user.email || '').trim().toLowerCase();
    if (!email) {
        throw new SnapshotAuthError(403, 'missing_email', 'Signed-in Supabase user has no email address');
    }

    return {
        accessToken,
        id: data.user.id,
        email
    };
}

async function requireAllowlistedSnapshotUser(req) {
    const user = await authenticateSupabaseUser(req);
    const supabase = getServiceSupabase();

    const { data, error } = await supabase
        .from('admin_emails')
        .select('id, email, active')
        .eq('email', user.email)
        .eq('active', true)
        .maybeSingle();

    if (error) {
        throw new SnapshotAuthError(500, 'allowlist_lookup_failed', error.message || 'Allowlist lookup failed');
    }

    if (!data) {
        throw new SnapshotAuthError(403, 'not_allowlisted', 'Signed-in email is not allowlisted for sync');
    }

    return user;
}

function writeSnapshotAuthError(res, error) {
    const statusCode = error instanceof SnapshotAuthError ? error.statusCode : 500;
    const code = error instanceof SnapshotAuthError ? error.code : 'internal_error';
    const message = error?.message || 'Unexpected authentication failure';

    return res.status(statusCode).json({
        error: code,
        message
    });
}

module.exports = {
    SnapshotAuthError,
    authenticateSupabaseUser,
    requireAllowlistedSnapshotUser,
    writeSnapshotAuthError
};

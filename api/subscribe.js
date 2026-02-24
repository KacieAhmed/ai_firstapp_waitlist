// Vercel Serverless Function — handles waitlist email submissions
// Stores emails in waitlist.md in the GitHub repo via the GitHub API

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER || 'KacieAhmed';
const REPO_NAME = process.env.REPO_NAME || 'ai_firstapp_waitlist';
const FILE_PATH = 'waitlist.md';

async function getFile() {
    const res = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
    return res.json();
}

async function updateFile(content, sha) {
    const body = {
        message: `Add new waitlist signup`,
        content: Buffer.from(content).toString('base64'),
        ...(sha && { sha }),
    };
    const res = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
        {
            method: 'PUT',
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        }
    );
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`GitHub PUT failed: ${res.status} — ${err}`);
    }
    return res.json();
}

function parseEmails(mdContent) {
    const emails = [];
    for (const line of mdContent.split('\n')) {
        const match = line.match(/^\d+\.\s+(.+@.+\..+)\s+—\s+/);
        if (match) emails.push(match[1].trim().toLowerCase());
    }
    return emails;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // GET — return current count
    if (req.method === 'GET') {
        try {
            const file = await getFile();
            if (!file) return res.status(200).json({ count: 0 });
            const content = Buffer.from(file.content, 'base64').toString('utf-8');
            const emails = parseEmails(content);
            return res.status(200).json({ count: emails.length });
        } catch (e) {
            return res.status(200).json({ count: 0 });
        }
    }

    // POST — add email
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { email } = req.body || {};

    if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Retry loop for concurrent writes (SHA conflict)
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const file = await getFile();
            let content, sha, emails;

            if (file) {
                content = Buffer.from(file.content, 'base64').toString('utf-8');
                sha = file.sha;
                emails = parseEmails(content);
            } else {
                content = '# Waitlist Signups\n\n';
                sha = null;
                emails = [];
            }

            if (emails.includes(normalizedEmail)) {
                return res.status(409).json({ error: "You're already on the waitlist!", count: emails.length });
            }

            const number = emails.length + 1;
            const timestamp = new Date().toISOString().split('T')[0];
            const newLine = `${number}. ${normalizedEmail} — ${timestamp}\n`;
            const updatedContent = content.trimEnd() + '\n' + newLine;

            await updateFile(updatedContent, sha);

            return res.status(200).json({
                message: "You're on the list! We'll be in touch soon.",
                count: number,
            });
        } catch (e) {
            if (attempt === 2) {
                console.error('Waitlist write failed:', e.message);
                return res.status(500).json({ error: 'Something went wrong. Please try again.' });
            }
            // Brief delay before retry
            await new Promise(r => setTimeout(r, 500));
        }
    }
};

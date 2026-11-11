const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '1mb' }));

const TWENTY_API_URL = process.env.TWENTY_API_URL || 'http://twenty-server:3000/api';
const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
const DOCUSEAL_API_URL = process.env.DOCUSEAL_API_URL || 'http://umbak-sign:3000';
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const WEBHOOK_SECRET = process.env.DOCUSEAL_WEBHOOK_SECRET || '';
const PORT = process.env.PORT || 4001;

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

function verifyWebhookSignature(req) {
  if (!WEBHOOK_SECRET) return true;
  const signature = req.headers['x-hmac-sha256'];
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function twentyGraphql(query, variables) {
  const response = await fetch(`${TWENTY_API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TWENTY_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0].message);
  }
  return json.data;
}

async function docusealApi(method, path, body) {
  const options = {
    method,
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${DOCUSEAL_API_URL}${path}`, options);
  return response.json();
}

async function createNoteForCompany(companyId, title, body) {
  const result = await twentyGraphql(
    `mutation CreateNote($input: NoteCreateInput!) {
      createNote(data: $input) { id }
    }`,
    { input: { title, bodyV2: { markdown: body } } }
  );
  const noteId = result.createNote.id;
  await twentyGraphql(
    `mutation CreateNoteTarget($input: NoteTargetCreateInput!) {
      createNoteTarget(data: $input) { id }
    }`,
    { input: { noteId, targetCompanyId: companyId } }
  );
  return noteId;
}

async function findCompanyByEmail(email) {
  const result = await twentyGraphql(
    `query FindPeople($filter: PersonFilterInput) {
      people(filter: $filter) {
        edges {
          node {
            id
            company { id name }
            emails { primaryEmail }
          }
        }
      }
    }`,
    {
      filter: {
        emails: { primaryEmail: { eq: email } },
      },
    }
  );
  const edges = result.people.edges;
  if (edges.length > 0 && edges[0].node.company) {
    return edges[0].node.company;
  }
  return null;
}

async function fetchCompanyData(companyId) {
  const result = await twentyGraphql(
    `query GetCompany($id: ID!) {
      company(id: $id) {
        name
        domainName { primaryLinkLabel }
        address { addressStreet1 }
        croNumber
        vatNumber
        industrySector
        sellerEmail
        hardwareRequirement
        softwareRequirement
        softwareLicence
        paymentProcessing
        preferredOs
        numberOfLocations
        usersPerLocation
        installationCost
      }
    }`,
    { id: companyId }
  );
  return result.company || null;
}

function buildDocuSealFields(company) {
  const mapping = [
    ['Trading Name', company.name],
    ['Registered Name', company.domainName?.primaryLinkLabel],
    ['CRO Number', company.croNumber],
    ['VAT Number', company.vatNumber],
    ['Business Address', company.address?.addressStreet1],
    ['Industry Sector', company.industrySector],
    ['Contact Email', company.sellerEmail],
    ['Hardware Requirement', company.hardwareRequirement],
    ['Software Requirement', company.softwareRequirement],
    ['Software Licence', company.softwareLicence],
    ['Payment Processing', company.paymentProcessing],
    ['Preferred OS', company.preferredOs],
    ['Number of Locations', company.numberOfLocations],
    ['Users Per Location', company.usersPerLocation],
    ['Installation Cost', company.installationCost],
  ];

  return mapping
    .filter(([, value]) => value)
    .map(([name, default_value]) => ({ name, default_value: String(default_value) }));
}

const EVENT_MESSAGES = {
  'form.started': { title: 'Document Sent', note: 'Document has been sent to the signer.' },
  'form.viewed': { title: 'Document Viewed', note: 'Signer has opened and viewed the document.' },
  'form.completed': { title: 'Document Signed', note: 'Signer has completed signing the document.' },
  'form.declined': { title: 'Document Declined', note: 'Signer has declined to sign the document. Follow-up required.' },
};

app.post('/webhook/docuseal', webhookLimiter, async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) {
      console.error('Webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { event_type, data } = req.body;
    console.log(`Received webhook: ${event_type}`);

    if (!EVENT_MESSAGES[event_type]) {
      return res.json({ status: 'ignored', event: event_type });
    }

    const submitters = data.submitters || [];
    for (const submitter of submitters) {
      const company = await findCompanyByEmail(submitter.email);
      if (!company) {
        console.log(`No company found for ${submitter.email}, skipping note creation`);
        continue;
      }

      const msg = EVENT_MESSAGES[event_type];
      const noteBody = [
        `**Event:** ${event_type}`,
        `**Signer:** ${submitter.name || submitter.email}`,
        `**Email:** ${submitter.email}`,
        `**Status:** ${submitter.status}`,
        submitter.completed_at ? `**Completed:** ${submitter.completed_at}` : null,
        data.submission_id ? `**Submission ID:** ${data.submission_id}` : null,
        '',
        msg.note,
      ]
        .filter(Boolean)
        .join('\n');

      await createNoteForCompany(company.id, `Umbak Sign: ${msg.title}`, noteBody);
      console.log(`Created note for company ${company.name} (${company.id})`);
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

app.post('/api/send', webhookLimiter, async (req, res) => {
  try {
    if (!DOCUSEAL_API_KEY) {
      return res.status(500).json({ error: 'Umbak Sign API key not configured' });
    }

    const { template_id, email, name, role, fields, company_id } = req.body;
    if (!template_id) {
      return res.status(400).json({ error: 'template_id is required' });
    }

    let recipientEmail = email;
    let recipientName = name;
    let submissionFields = fields || [];

    if (company_id) {
      const companyData = await fetchCompanyData(company_id);
      if (companyData) {
        if (!recipientEmail) recipientEmail = companyData.sellerEmail;
        if (!recipientName) recipientName = companyData.name;
        if (submissionFields.length === 0) {
          submissionFields = buildDocuSealFields(companyData);
          console.log(`Built ${submissionFields.length} fields from company ${company_id}`);
        }
      }
    }

    if (!recipientEmail) {
      return res.status(400).json({ error: 'email is required (or provide company_id with sellerEmail)' });
    }

    const submission = await docusealApi('POST', '/api/submissions', {
      template_id,
      send_email: true,
      submitters: [
        {
          role: role || 'First Party',
          email: recipientEmail,
          name: recipientName || recipientEmail,
          fields: submissionFields,
        },
      ],
    });

    const submitters = Array.isArray(submission) ? submission : [];
    const firstSubmitter = submitters[0];
    const submissionId = firstSubmitter?.submission_id || 'unknown';
    const signingUrl = firstSubmitter?.embed_src || null;

    if (company_id) {
      await createNoteForCompany(
        company_id,
        'Umbak Sign: Document Sent',
        [
          `**Template ID:** ${template_id}`,
          `**Sent to:** ${recipientName || recipientEmail} (${recipientEmail})`,
          `**Submission ID:** ${submissionId}`,
          signingUrl ? `**Signing Link:** ${signingUrl}` : null,
          '',
          'Document has been sent for signing via Umbak Sign.',
        ].filter(Boolean).join('\n')
      );
    }

    res.json({
      success: true,
      submission_id: submissionId,
      signing_url: signingUrl,
      submitters,
    });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: 'Failed to send document' });
  }
});

app.get('/api/templates', async (_req, res) => {
  try {
    const templates = await docusealApi('GET', '/api/templates');
    res.json(templates);
  } catch (err) {
    console.error('Templates fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

app.get('/api/submissions/:id', async (req, res) => {
  try {
    const submission = await docusealApi('GET', `/api/submissions/${req.params.id}`);
    res.json(submission);
  } catch (err) {
    console.error('Submission fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch submission' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Sign integration service running on port ${PORT}`);
});

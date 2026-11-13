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
const IRISHSIGN_API_URL = process.env.IRISHSIGN_API_URL || 'http://umbak-sign:3000';
const IRISHSIGN_API_KEY = process.env.IRISHSIGN_API_KEY;
const WEBHOOK_SECRET = process.env.IRISHSIGN_WEBHOOK_SECRET || '';
const UMBAK_SIGNER_EMAIL = process.env.UMBAK_SIGNER_EMAIL || 'muneeb.shaikh@irishpayments.ie';
const UMBAK_SIGNER_NAME = process.env.UMBAK_SIGNER_NAME || 'Umbak Technologies Ltd';
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

async function irishSignApi(method, path, body) {
  const options = {
    method,
    headers: {
      'X-Auth-Token': IRISHSIGN_API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${IRISHSIGN_API_URL}${path}`, options);
  return response.json();
}

async function attachSignedDocumentToCompany(companyId, submissionId, documentUrls) {
  const docLinks = documentUrls
    .map((url, i) => `- [Signed Document ${i + 1}](${url})`)
    .join('\n');

  const signUrl = `${IRISHSIGN_API_URL}/submissions/${submissionId}`;

  const noteBody = [
    `**Submission ID:** ${submissionId}`,
    '',
    'All parties have signed. Signed documents:',
    docLinks,
    '',
    `[View in Umbak Sign](${signUrl})`,
  ].join('\n');

  await createNoteForCompany(companyId, 'Umbak Sign: Signed Document Attached', noteBody);
  console.log(`Attached ${documentUrls.length} signed document link(s) for company ${companyId}`);
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

function buildIrishSignFields(company) {
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
    .map(([name, default_value]) => ({ name, default_value: String(default_value), readonly: true }));
}

const EVENT_MESSAGES = {
  'form.started': { title: 'Document Sent', note: 'Document has been sent to the signer.' },
  'form.viewed': { title: 'Document Viewed', note: 'Signer has opened and viewed the document.' },
  'form.completed': { title: 'Document Signed', note: 'Signer has completed signing the document.' },
  'form.declined': { title: 'Document Declined', note: 'Signer has declined to sign the document. Follow-up required.' },
};

app.post('/webhook/irishsign', webhookLimiter, async (req, res) => {
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

      if (event_type === 'form.completed') {
        try {
          const submission = await irishSignApi('GET', `/api/submissions/${data.submission_id}`);
          const documentUrls = [];
          if (submission.combined_document_url) {
            documentUrls.push(submission.combined_document_url);
          } else if (submission.documents && submission.documents.length > 0) {
            for (const doc of submission.documents) {
              if (doc.url) documentUrls.push(doc.url);
            }
          }
          if (documentUrls.length > 0) {
            await attachSignedDocumentToCompany(company.id, data.submission_id, documentUrls);
          }
        } catch (docErr) {
          console.error('Signed document attachment error:', docErr.message);
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook processing error:', err.message);
    res.status(500).json({ error: 'Processing failed' });
  }
});

app.post('/api/send', webhookLimiter, async (req, res) => {
  try {
    if (!IRISHSIGN_API_KEY) {
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
          submissionFields = buildIrishSignFields(companyData);
          console.log(`Built ${submissionFields.length} fields from company ${company_id}`);
        }
      }
    }

    if (!recipientEmail) {
      return res.status(400).json({ error: 'email is required (or provide company_id with sellerEmail)' });
    }

    const today = new Date().toLocaleDateString('en-IE');
    const umbakSignatureFields = [
      { name: 'Umbak Print Name', default_value: UMBAK_SIGNER_NAME, readonly: true },
      { name: 'Umbak Title', default_value: 'Director', readonly: true },
      { name: 'Umbak Date', default_value: today, readonly: true },
    ];

    const submitters = [
      {
        role: 'First Party',
        email: UMBAK_SIGNER_EMAIL,
        name: UMBAK_SIGNER_NAME,
        fields: [...submissionFields, ...umbakSignatureFields],
        send_email: true,
      },
      {
        role: 'Second Party',
        email: recipientEmail,
        name: recipientName || recipientEmail,
        fields: [
          { name: 'Customer Print Name', default_value: recipientName || recipientEmail, readonly: true },
          { name: 'Customer Title', default_value: 'Authorised Signatory', readonly: true },
          { name: 'Customer Date', default_value: today, readonly: true },
        ],
        send_email: true,
      },
    ];

    const submission = await irishSignApi('POST', '/api/submissions', {
      template_id,
      send_email: true,
      order: 'preserved',
      submitters,
    });

    const responseSubmitters = Array.isArray(submission) ? submission : [];
    const umbakSubmitter = responseSubmitters[0];
    const customerSubmitter = responseSubmitters[1];
    const submissionId = umbakSubmitter?.submission_id || 'unknown';

    if (company_id) {
      await createNoteForCompany(
        company_id,
        'Umbak Sign: Contract Sent',
        [
          `**Template ID:** ${template_id}`,
          `**Step 1:** ${UMBAK_SIGNER_NAME} (${UMBAK_SIGNER_EMAIL}) signs first`,
          `**Step 2:** ${recipientName || recipientEmail} (${recipientEmail}) signs after`,
          `**Submission ID:** ${submissionId}`,
          '',
          'Contract sent for two-party signing. Customer receives it after Umbak signs.',
        ].join('\n')
      );
    }

    res.json({
      success: true,
      submission_id: submissionId,
      submitters: responseSubmitters,
    });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: 'Failed to send document' });
  }
});

app.get('/api/templates', async (_req, res) => {
  try {
    const templates = await irishSignApi('GET', '/api/templates');
    res.json(templates);
  } catch (err) {
    console.error('Templates fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

app.get('/api/submissions/:id', async (req, res) => {
  try {
    const submission = await irishSignApi('GET', `/api/submissions/${req.params.id}`);
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

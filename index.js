const express = require('express');
const Stripe = require('stripe');
const { google } = require('googleapis');
const Airtable = require('airtable');

const app = express();
const port = process.env.PORT || 3000;

// Initialize APIs
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY
}).base('appUNIsu8KgvOlmi0'); // Growth AI base ID

// Gmail OAuth2 setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// Middleware
app.use(express.json());
app.use(express.raw({ type: 'application/json' }));

// Logging array to store recent activities
let logs = [];

function addLog(message) {
  const timestamp = new Date().toISOString();
  logs.push({ timestamp, message });
  console.log(`[${timestamp}] ${message}`);
  
  // Keep only last 50 logs
  if (logs.length > 50) {
    logs = logs.slice(-50);
  }
}

// Send Gmail alert
async function sendGmailAlert(paymentData) {
  try {
    const subject = `🚨 Payment Failed Alert - ${paymentData.customer_email || 'Unknown Customer'}`;
    const body = `
Payment Failure Detected!

Details:
- Payment ID: ${paymentData.payment_id}
- Customer: ${paymentData.customer_email || 'Not available'}
- Amount: $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency.toUpperCase()}
- Failure Code: ${paymentData.failure_code || 'Not specified'}
- Failure Message: ${paymentData.failure_message || 'Not specified'}
- Date: ${paymentData.failed_at}

Please review and take appropriate action.

Best regards,
Failed Payments Monitor
    `;

    const message = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `To: ${process.env.ALERT_EMAIL || 'admin@example.com'}`,
      `Subject: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    addLog(`Gmail alert sent for payment ${paymentData.payment_id}`);
  } catch (error) {
    addLog(`Error sending Gmail alert: ${error.message}`);
  }
}

// Add failed payment to Airtable
async function addToAirtable(paymentData) {
  try {
    const table = airtable('Failed Payments');
    
    const record = await table.create([
      {
        fields: {
          'Payment ID': paymentData.payment_id,
          'Customer Email': paymentData.customer_email || 'Unknown',
          'Amount': paymentData.amount / 100,
          'Currency': paymentData.currency.toUpperCase(),
          'Failure Code': paymentData.failure_code || 'Unknown',
          'Failure Message': paymentData.failure_message || 'Unknown',
          'Failed At': paymentData.failed_at,
          'Status': 'New',
          'Created At': new Date().toISOString()
        }
      }
    ]);

    addLog(`Added failed payment record to Airtable: ${record[0].id}`);
    return record[0];
  } catch (error) {
    addLog(`Error adding to Airtable: ${error.message}`);
    throw error;
  }
}

// Process failed payment
async function processFailedPayment(event) {
  try {
    let paymentData = {};

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      paymentData = {
        payment_id: paymentIntent.id,
        customer_email: paymentIntent.receipt_email || 'Unknown',
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        failure_code: paymentIntent.last_payment_error?.code,
        failure_message: paymentIntent.last_payment_error?.message,
        failed_at: new Date(event.created * 1000).toISOString()
      };
    } else if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      paymentData = {
        payment_id: invoice.id,
        customer_email: invoice.customer_email || 'Unknown',
        amount: invoice.amount_due,
        currency: invoice.currency,
        failure_code: 'invoice_payment_failed',
        failure_message: 'Invoice payment failed',
        failed_at: new Date(event.created * 1000).toISOString()
      };
    } else if (event.type === 'charge.failed') {
      const charge = event.data.object;
      paymentData = {
        payment_id: charge.id,
        customer_email: charge.receipt_email || charge.billing_details?.email || 'Unknown',
        amount: charge.amount,
        currency: charge.currency,
        failure_code: charge.failure_code,
        failure_message: charge.failure_message,
        failed_at: new Date(event.created * 1000).toISOString()
      };
    }

    addLog(`Processing failed payment: ${paymentData.payment_id}`);

    // Send Gmail alert
    await sendGmailAlert(paymentData);

    // Add to Airtable
    await addToAirtable(paymentData);

    addLog(`Successfully processed failed payment: ${paymentData.payment_id}`);
  } catch (error) {
    addLog(`Error processing failed payment: ${error.message}`);
    throw error;
  }
}

// Webhook endpoint for Stripe
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    addLog(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (['payment_intent.payment_failed', 'invoice.payment_failed', 'charge.failed'].includes(event.type)) {
    try {
      await processFailedPayment(event);
      addLog(`Webhook processed successfully: ${event.type}`);
    } catch (error) {
      addLog(`Error processing webhook: ${error.message}`);
      return res.status(500).send('Internal Server Error');
    }
  } else {
    addLog(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'Stripe Payment Monitor',
    status: 'running',
    endpoints: {
      'GET /': 'Status and available endpoints',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'POST /test': 'Manual test run',
      'POST /webhook/stripe': 'Stripe webhook endpoint'
    },
    description: 'Monitors Stripe for failed payments, sends Gmail alerts, and updates Airtable'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/logs', (req, res) => {
  res.json({
    logs: logs.slice(-20), // Show last 20 logs
    total: logs.length
  });
});

app.post('/test', async (req, res) => {
  try {
    addLog('Manual test initiated');
    
    // Create a test payment failure event
    const testPaymentData = {
      payment_id: 'test_' + Date.now(),
      customer_email: 'test@example.com',
      amount: 2500, // $25.00
      currency: 'usd',
      failure_code: 'card_declined',
      failure_message: 'Your card was declined.',
      failed_at: new Date().toISOString()
    };

    // Send test alert
    await sendGmailAlert(testPaymentData);
    
    // Add test record to Airtable
    await addToAirtable(testPaymentData);
    
    addLog('Manual test completed successfully');
    
    res.json({
      success: true,
      message: 'Test completed successfully',
      testData: testPaymentData
    });
  } catch (error) {
    addLog(`Manual test failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  addLog(`Unhandled error: ${error.message}`);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(port, () => {
  addLog(`Stripe Payment Monitor started on port ${port}`);
});

module.exports = app;
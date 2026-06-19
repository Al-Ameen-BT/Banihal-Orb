import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

async function testConnection() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  console.log('Testing SMTP Connection with settings:');
  console.log(`Host: ${host}`);
  console.log(`Port: ${port}`);
  console.log(`User: ${user}`);
  console.log(`Pass length: ${pass ? pass.length : 0}`);

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
    // Adding standard TLS options for Outlook
    tls: {
      ciphers: 'SSLv3',
      rejectUnauthorized: false
    }
  });

  try {
    const success = await transporter.verify();
    if (success) {
      console.log('✅ Connection successful! SMTP is configured correctly.');
    }
  } catch (error) {
    console.error('❌ Connection failed:', error);
  }
}

testConnection();

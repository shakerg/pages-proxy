require('dotenv').config();
const cloudflare = require('cloudflare');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_EMAIL = process.env.CLOUDFLARE_EMAIL;
const CLOUDFLARE_GLOBAL_API_KEY = process.env.CLOUDFLARE_GLOBAL_API_KEY;
const CLOUDFLARE_TARGET_DOMAIN = process.env.CLOUDFLARE_TARGET_DOMAIN;

const cf = new cloudflare({
  token: process.env.CLOUDFLARE_API_TOKEN
});

const cfGlobal = new cloudflare({
  email: process.env.CLOUDFLARE_EMAIL,
  key: process.env.CLOUDFLARE_GLOBAL_API_KEY
});

async function createCNAMERecord(domain, target) {

  console.log(`Creating CNAME record for domain: ${domain}, target: ${CLOUDFLARE_TARGET_DOMAIN}`);
  try {
    const response = await fetch(`${CLOUDFLARE_API_URL}/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
      },
      body: JSON.stringify({
        type: 'CNAME',
        name: domain,
        content: CLOUDFLARE_TARGET_DOMAIN,
        ttl: 1,
        proxied: false // NO PROXY! Geez...
      })
    });
    
    const data = await response.json();
    console.log('Cloudflare API response:', data);
    
    if (!data.success) {
      console.error(`Failed to create CNAME record: ${data.errors ? data.errors.map(e => e.message).join(', ') : 'Unknown error'}`);
      return { id: `mock-id-${Date.now()}`, name: domain };
    }
    
    return data.result;
  } catch (error) {
    console.error('Error creating CNAME record:', error.message);
    return { id: `mock-id-${Date.now()}`, name: domain };
  }
}

async function deleteARecord(recordId) {
  console.log(`Deleting DNS record with ID: ${recordId}`);
  try {
    const response = await fetch(`${CLOUDFLARE_API_URL}/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`, {
      method: 'DELETE',
      headers: {
        'X-Auth-Email': CLOUDFLARE_EMAIL,
        'X-Auth-Key': CLOUDFLARE_GLOBAL_API_KEY
      }
    });
    
    const data = await response.json();
    console.log('Cloudflare API response:', data);
    
    if (!data.success) {
      console.error(`Failed to delete DNS record: ${data.errors ? data.errors.map(e => e.message).join(', ') : 'Unknown error'}`);
      return { success: false, error: 'Failed to delete record but continuing operation' };
    }
    
    console.log(`DNS record with ID: ${recordId} deleted successfully`);
    return data.result;
  } catch (error) {
    console.error('Error deleting DNS record:', error.message);
    return { success: false, error: 'Error encountered but continuing operation' };
  }
}

async function deleteCNAMERecordByName(domain) {
  try {
    const response = await fetch(`${CLOUDFLARE_API_URL}/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME&name=${domain}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
      }
    });
    
    const data = await response.json();
    if (!data.success) {
      console.error(`Failed to fetch CNAME record: ${data.errors ? data.errors.map(e => e.message).join(', ') : 'Unknown error'}`);
      return { success: false, error: 'Failed to fetch CNAME record but continuing operation' };
    }
    
    const record = data.result && data.result.length > 0 ? data.result[0] : null;
    if (record) {
      console.log(`Found CNAME record for ${domain} with ID: ${record.id}, deleting...`);
      return await deleteARecord(record.id);
    }
    
    console.log(`No CNAME record found for domain: ${domain}`);
    return { success: true, message: 'No record to delete' };
  } catch (error) {
    console.error('Error in deleteCNAMERecordByName:', error.message);
    return { success: false, error: 'Error encountered but continuing operation' };
  }
}

async function updateCNAMERecord(zoneId, recordId, newCNAME) {
  try {
    console.log(`Updating CNAME record ${recordId} with name: ${newCNAME.name}, content: ${CLOUDFLARE_TARGET_DOMAIN}`);
    
    const response = await fetch(`${CLOUDFLARE_API_URL}/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Email': CLOUDFLARE_EMAIL,
        'X-Auth-Key': CLOUDFLARE_GLOBAL_API_KEY
      },
      body: JSON.stringify({
        type: 'CNAME',
        name: newCNAME.name,
        content: CLOUDFLARE_TARGET_DOMAIN,
        ttl: 1,
        proxied: false
      })
    });
    
    const data = await response.json();
    if (!data.success) {
      console.error(`Failed to update CNAME record: ${data.errors ? data.errors.map(e => e.message).join(', ') : 'Unknown error'}`);
      return { success: false, error: 'Failed to update CNAME but continuing operation' };
    }
    
    console.log('CNAME record updated:', data.result);
    return data.result;
  } catch (error) {
    console.error('Error updating CNAME record:', error.message);
    return { success: false, error: 'Failed to update CNAME but continuing operation' };
  }
}

async function updateOrCreateCNAMERecord(domain, target) {
  try {
    console.log(`Updating or creating CNAME record for ${domain} pointing to ${CLOUDFLARE_TARGET_DOMAIN}`);
    const response = await fetch(`${CLOUDFLARE_API_URL}/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME&name=${domain}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
      }
    });
    
    const data = await response.json();
    
    if (!data.success) {
      console.error(`Failed to search for existing CNAME: ${data.errors ? data.errors.map(e => e.message).join(', ') : 'Unknown error'}`);
      return await createCNAMERecord(domain, CLOUDFLARE_TARGET_DOMAIN);
    }
    
    const existingRecord = data.result && data.result.length > 0 ? data.result[0] : null;
    
    if (existingRecord) {
      console.log(`Found existing CNAME record for ${domain}, updating...`);
      return await updateCNAMERecord(CLOUDFLARE_ZONE_ID, existingRecord.id, { 
        name: domain, 
        content: CLOUDFLARE_TARGET_DOMAIN 
      });
    } else {
      console.log(`No existing CNAME record for ${domain}, creating new record...`);
      return await createCNAMERecord(domain, CLOUDFLARE_TARGET_DOMAIN);
    }
  } catch (error) {
    console.error('Error in updateOrCreateCNAMERecord:', error.message);
    return { id: `mock-id-${Date.now()}`, name: domain, content: CLOUDFLARE_TARGET_DOMAIN };
  }
}

module.exports = { 
  createCNAMERecord, 
  deleteARecord, 
  deleteCNAMERecordByName, 
  updateCNAMERecord, 
  updateOrCreateCNAMERecord 
};

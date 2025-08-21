let fetch;
(async () => {
  const module = await import('node-fetch');
  fetch = module.default;
})();
const db = require('./database');
const cloudflare = require('./cloudflare');
const { checkAndRefreshToken } = require('./utils/tokenManager');
const logger = require('./utils/logger');

async function getOctokit() {
  const { Octokit } = await import('@octokit/rest');
  return new Octokit({ auth: process.env.GITHUB_APP_TOKEN });
}

async function ensureFetch() {
  if (!fetch) {
    const module = await import('node-fetch');
    fetch = module.default;
  }
  return fetch;
}

async function handleWebhook(req, res) {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  console.log(`Received GitHub webhook event: ${event}`);

  try {
    await checkAndRefreshToken();
        switch (event) {
      case 'repository':
        await handleRepositoryEvent(payload);
        break;
      case 'page_build':
        await handlePageBuildEvent(payload);
        break;
      case 'pages':
        await handlePagesEvent(payload);
        break;
      // Add more event handlers as needed
      default:
        console.log(`Unhandled event: ${event}`);
    }
    
    res.status(200).end();
  } catch (error) {
    console.error(`Error processing webhook: ${error.message}`);
    res.status(200).end();
  }
}

async function handleRepositoryEvent(payload) {
  const { action, repository } = payload;
  const repoName = repository.full_name;
  
  if (action === 'created' || action === 'updated') {
    const pagesUrl = await fetchPagesUrl(repoName);
    if (pagesUrl) {
      const customDomain = repository.pages?.custom_domain;
      console.log(`Custom domain for ${repoName}: ${customDomain}`);
      await db.storePagesUrl(repoName, pagesUrl.pagesUrl, customDomain);
      if (customDomain) {
        await cloudflare.updateOrCreateCNAMERecord(customDomain, 'foundation.redcloud.city');
      }
    }
  } else if (action === 'deleted') {
    const existingRecord = await fetchExistingDatabaseRecord(repoName);
    if (existingRecord && existingRecord.custom_domain) {
      console.log(`Deleting Cloudflare CNAME record for ${existingRecord.custom_domain} due to repository deletion`);
      await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
    }
    
    await db.removePagesUrl(repoName);
  }
}

async function handlePagesEvent(payload) {
  console.log('Received pages event:', JSON.stringify(payload, null, 2));
  const { action, repository } = payload;
  const repoName = repository.full_name;
  
  try {
    const existingRecord = await fetchExistingDatabaseRecord(repoName);
    console.log(`Existing record for ${repoName}:`, existingRecord);
    
    if (action === 'created' || action === 'updated') {
      await processCustomDomainChange(payload, existingRecord);
    } else if (action === 'deleted' || action === 'undeploy') {
      if (existingRecord && existingRecord.custom_domain) {
        console.log(`Pages site deleted/undeployed for ${repoName}. Removing custom domain: ${existingRecord.custom_domain}`);
        
        await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
        await db.storePagesUrl(repoName, existingRecord.pages_url, null);
        
        console.log(`Successfully removed CNAME record for ${existingRecord.custom_domain} from Cloudflare`);
      }
    }
  } catch (error) {
    logger.error('Error handling pages event for %s:', repoName, error);
  }
}

async function processCustomDomainChange(payload, existingRecord) {
  const { repository, pages } = payload;
  const repoName = repository.full_name;
  const customDomain = pages?.cname || null;
  
  if (customDomain) {
    console.log(`Found custom domain in payload for ${repoName}: ${customDomain}`);
    
    if (existingRecord && existingRecord.custom_domain && existingRecord.custom_domain !== customDomain) {
      console.log(`Custom domain changed for ${repoName}. Old: ${existingRecord.custom_domain}, New: ${customDomain}`);
      
      console.log(`Deleting old Cloudflare CNAME record for ${existingRecord.custom_domain}`);
      await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
    }
    
    const pagesUrl = pages?.html_url || (existingRecord ? existingRecord.pages_url : repository.html_url);
    await db.storePagesUrl(repoName, pagesUrl, customDomain);
    await cloudflare.updateOrCreateCNAMERecord(customDomain, 'foundation.redcloud.city');
    
    console.log(`Updated Cloudflare CNAME record for ${customDomain}`);
  } 
  else if (existingRecord && existingRecord.custom_domain) {
    console.log(`Custom domain removal detected for ${repoName}. Previous domain: ${existingRecord.custom_domain}`);
    console.log(`Deleting Cloudflare CNAME record for ${existingRecord.custom_domain}`);

    await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
    const pagesUrl = pages?.html_url || existingRecord.pages_url;
    await db.storePagesUrl(repoName, pagesUrl, null);
    
    console.log(`Successfully removed CNAME record for ${existingRecord.custom_domain} from Cloudflare and updated database`);
  }
}

async function handlePageBuildEvent(payload) {
  console.log('Received page_build event:', JSON.stringify(payload, null, 2));
  const { repository } = payload;
  const repoName = repository.full_name;
  
  try {
    const existingRecord = await fetchExistingDatabaseRecord(repoName);
    console.log(`Existing record for ${repoName}:`, existingRecord);
    console.log(`Fetching current CNAME for ${repoName} from GitHub Pages API...`);
    let pagesResult;
    try {
      pagesResult = await fetchPagesCname(repoName);
      console.log('Current Pages API result for %s:', repoName, pagesResult);
    } catch (error) {
      if (error.status === 404) {
        console.log(`No GitHub Pages site found for ${repoName} (404 response)`);
        pagesResult = null;
      } else {
        console.error(`Error fetching Pages information: ${error.message}`);
      }
    }
    
    if (existingRecord && existingRecord.custom_domain && 
        (!pagesResult || !pagesResult.cname || pagesResult.cname === '')) {
      console.log(`Custom domain removal detected for ${repoName}. Previous domain: ${existingRecord.custom_domain}`);
      console.log(`Deleting Cloudflare CNAME record for ${existingRecord.custom_domain}`);
      await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
      await db.storePagesUrl(repoName, repository.html_url || existingRecord.pages_url, null);
      
      console.log(`Successfully removed CNAME record for ${existingRecord.custom_domain} from Cloudflare and updated database`);
      return;
    }
    
    if (pagesResult && pagesResult.cname) {
      const customDomain = pagesResult.cname;
      const source = pagesResult.source;
      console.log(`Found active custom domain via API for ${repoName}: ${customDomain}`);
      
      if (existingRecord && existingRecord.custom_domain && existingRecord.custom_domain !== customDomain) {
        console.log(`Custom domain changed for ${repoName}. Old: ${existingRecord.custom_domain}, New: ${customDomain}`);
        
        console.log(`Deleting old Cloudflare CNAME record for ${existingRecord.custom_domain}`);
        await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
      }
      
      await db.storePagesUrl(repoName, repository.html_url || (existingRecord ? existingRecord.pages_url : null), customDomain);
      await cloudflare.updateOrCreateCNAMERecord(customDomain, 'foundation.redcloud.city');
      console.log(`Updated/created Cloudflare CNAME record for ${customDomain}`);
      return;
    }
    
    console.log(`No custom domain found via Pages API for ${repoName}, checking CNAME file...`);
    let cnameContent;
    try {
      cnameContent = await fetchCnameFile(repoName);
    } catch (error) {
      console.log(`Error fetching CNAME file: ${error.message}`);
      cnameContent = null;
    }
    
    if (cnameContent) {
      const customDomain = cnameContent.trim();
      console.log(`Found custom domain via CNAME file for ${repoName}: ${customDomain}`);
      
      if (existingRecord && existingRecord.custom_domain && existingRecord.custom_domain !== customDomain) {
        console.log(`Custom domain changed for ${repoName}. Old: ${existingRecord.custom_domain}, New: ${customDomain}`);
        
        console.log(`Deleting old Cloudflare CNAME record for ${existingRecord.custom_domain}`);
        await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
      }
      
      await db.storePagesUrl(repoName, repository.html_url || (existingRecord ? existingRecord.pages_url : null), customDomain);
      await cloudflare.updateOrCreateCNAMERecord(customDomain, 'foundation.redcloud.city');
      console.log(`Updated/created Cloudflare CNAME record for ${customDomain} from CNAME file`);
    } else {
      console.log(`No custom domain found in CNAME file for ${repoName}`);
      
      if (existingRecord && existingRecord.custom_domain) {
        console.log(`Custom domain removal confirmed for ${repoName}. Previous domain: ${existingRecord.custom_domain}`);
        console.log(`Deleting Cloudflare CNAME record for ${existingRecord.custom_domain}`);

        await cloudflare.deleteCNAMERecordByName(existingRecord.custom_domain);
        await db.storePagesUrl(repoName, repository.html_url || existingRecord.pages_url, null);

        console.log(`Successfully removed CNAME record for ${existingRecord.custom_domain} from Cloudflare and updated database`);
      } else {
        console.log(`No custom domain changes needed for ${repoName}`);
      }
    }
  } catch (error) {
    logger.error('Error handling page_build event for %s:', repoName, error);
  }
}

async function fetchPagesUrl(repoName) {
  try {
    const octokit = await getOctokit();
    const { data } = await octokit.repos.getPages({
      owner: repoName.split('/')[0],
      repo: repoName.split('/')[1],
    });
    console.log(`Fetched Pages URL for ${repoName}: ${data.html_url}`);
    console.log(`Fetched CNAME for ${repoName}: ${data.cname}`);
    return { pagesUrl: data.html_url, cname: data.cname };
  } catch (error) {
    if (error.status === 404) {
      console.log(`No GitHub Pages site found for repository: ${repoName}`);
    } else {
      logger.error('Error fetching Pages URL for %s:', repoName, error);
    }
    return null;
  }
}

async function fetchPagesCname(repoName) {
  const octokit = await getOctokit();
  const [owner, repo] = repoName.split('/');
  console.log(`Fetching Pages CNAME for repository: ${owner}/${repo}`);
  
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pages', {
    owner,
    repo
  });
  
  console.log(`Fetched CNAME for ${repoName}: ${data.cname}`);
  return { cname: data.cname, source: data.source };
}

async function fetchCnameFile(repoName) {
  const [owner, repo] = repoName.split('/');
  console.log(`Attempting to fetch CNAME file from repository: ${owner}/${repo}`);
  
  // Try common branch names
  const branches = ['main', 'master', 'gh-pages'];
  const octokit = await getOctokit();
  
  for (const branch of branches) {
    try {
      console.log(`Trying branch: ${branch}`);
      
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: 'CNAME',
        ref: branch
      });
      
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      console.log(`CNAME file found in ${branch} branch with content: ${content}`);
      return content;
    } catch (error) {
      const status = error.status || error.message;
      if (status === 404) {
        console.log(`No CNAME file in ${branch} branch`);
      } else {
        console.error(`Error fetching CNAME file from ${branch} branch:`, status);
      }
    }
  }
  
  console.log(`CNAME file not found in any common branch for ${repoName}`);
  
  try {
    const { data: repoData } = await octokit.repos.get({
      owner,
      repo
    });
    
    console.log(`Repository exists: ${repoData.full_name}, default branch: ${repoData.default_branch}`);
    
    if (!branches.includes(repoData.default_branch)) {
      try {
        console.log(`Trying default branch: ${repoData.default_branch}`);
        
        const { data } = await octokit.repos.getContent({
          owner,
          repo,
          path: 'CNAME',
          ref: repoData.default_branch
        });
        
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        console.log(`CNAME file found in default branch with content: ${content}`);
        return content;
      } catch (error) {
        if (error.status === 404) {
          console.log(`No CNAME file in default branch ${repoData.default_branch}`);
        } else {
          console.error(`Error fetching CNAME file from default branch:`, error.status || error.message);
        }
      }
    }
    
    console.log(`No CNAME file found for ${repoName} in any branch`);
    return null;
    
  } catch (error) {
    if (error.status === 404) {
      console.log(`Repository not found: ${repoName}`);
    } else {
      console.error(`Error getting repository information:`, error.status || error.message);
    }
    return null;
  }
}

async function fetchExistingDatabaseRecord(repoName) {
  return new Promise((resolve, reject) => {
    const db = require('./database');
    const sqlite3 = require('sqlite3').verbose();
    const dbPath = process.env.DB_PATH || 'pages.db';
    console.log(`Using database path in fetchExistingDatabaseRecord: ${dbPath}`);
    
    const dbInstance = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error connecting to database in fetchExistingDatabaseRecord:', err);
        return reject(err);
      }
      
      dbInstance.get('SELECT * FROM pages_urls WHERE repo_name = ?', [repoName], (err, row) => {
        dbInstance.close();
        
        if (err) {
          logger.error('Error querying database for %s:', repoName, err);
          return reject(err);
        }
        
        if (row) {
          console.log('Found existing database record for %s:', repoName, row);
        } else {
          console.log(`No existing database record found for ${repoName}`);
        }
        
        resolve(row || null);
      });
    });
  });
}

module.exports = { handleWebhook };

#!/usr/bin/env node

/**
 * Masters Pool Score Fetcher
 * Runs via GitHub Actions every 30 minutes during tournament hours.
 * Fetches live scores from ESPN's Golf API and updates pool-data.json.
 */

const fs = require('fs');
const path = require('path');

const POOL_DATA_FILE = path.join(__dirname, 'pool-data.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');

// ESPN Golf API - Masters 2025 event ID
// The Masters = tournament ID 2025 (year), event varies - we fetch current PGA tour events
const ESPN_MASTERS_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const ESPN_LEADERBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/leaderboard';

async function fetchScores() {
  console.log('Fetching Masters scores from ESPN...');
  
  let poolData = JSON.parse(fs.readFileSync(POOL_DATA_FILE, 'utf8'));
  
  // Only fetch if draw has been completed
  if (!poolData.drawCompleted || poolData.assignments.length === 0) {
    console.log('Draw not yet completed. Skipping score fetch.');
    return;
  }

  try {
    // Try ESPN scoreboard first
    const response = await fetch(ESPN_MASTERS_URL);
    const data = await response.json();
    
    let mastersEvent = null;
    
    // Find the Masters in the events list
    if (data.events) {
      mastersEvent = data.events.find(e => 
        e.name && (e.name.toLowerCase().includes('masters') || e.shortName?.toLowerCase().includes('masters'))
      );
    }
    
    if (!mastersEvent) {
      // Try leaderboard endpoint
      const lbResponse = await fetch(ESPN_LEADERBOARD_URL);
      const lbData = await lbResponse.json();
      if (lbData.events) {
        mastersEvent = lbData.events.find(e => 
          e.name && (e.name.toLowerCase().includes('masters') || e.shortName?.toLowerCase().includes('masters'))
        );
      }
    }

    if (!mastersEvent) {
      console.log('Masters event not found in ESPN data. Dumping available events:');
      if (data.events) {
        data.events.forEach(e => console.log(' -', e.name));
      }
      // Try direct Masters leaderboard
      await fetchFromMastersDirectly(poolData);
      return;
    }

    console.log(`Found event: ${mastersEvent.name}`);
    
    // Parse competitors/leaderboard
    const competitions = mastersEvent.competitions || [];
    if (competitions.length === 0) {
      console.log('No competition data found.');
      return;
    }

    const competition = competitions[0];
    const competitors = competition.competitors || [];
    
    const scores = {};
    let tournamentStarted = false;
    
    competitors.forEach(player => {
      const playerName = player.athlete?.displayName || player.athlete?.fullName;
      if (!playerName) return;
      
      const score = player.score?.value ?? null;
      const toPar = player.linescores ? 
        player.linescores.reduce((sum, ls) => sum + (ls.value || 0), 0) : 
        (player.statistics?.find(s => s.name === 'toPar')?.displayValue || null);
      
      const status = player.status?.type?.name || 'active';
      const madeCut = !player.status?.type?.name?.toLowerCase().includes('cut');
      const currentRound = player.period || 1;
      
      if (score !== null) tournamentStarted = true;
      
      // Find matching golfer in our pool by name
      const matchedGolfer = poolData.golfers.find(g => {
        const espnName = playerName.toLowerCase();
        const ourName = g.name.toLowerCase();
        return espnName === ourName || 
               espnName.includes(ourName.split(' ').pop()) ||
               ourName.includes(espnName.split(' ').pop());
      });
      
      if (matchedGolfer) {
        scores[matchedGolfer.id] = {
          displayName: playerName,
          totalScore: typeof toPar === 'number' ? toPar : parseScore(toPar),
          currentRound,
          madeCut,
          status,
          position: player.status?.position?.displayName || player.status?.displayValue || '--',
          roundScores: (player.linescores || []).map(ls => ls.displayValue || ls.value),
          withdrawn: status === 'WD' || status === 'DQ'
        };
      }
    });

    poolData.scores = scores;
    poolData.tournamentStarted = tournamentStarted;
    poolData.lastUpdated = new Date().toISOString();
    
    fs.writeFileSync(POOL_DATA_FILE, JSON.stringify(poolData, null, 2));
    console.log(`Updated scores for ${Object.keys(scores).length} players. Last updated: ${poolData.lastUpdated}`);
    
  } catch (err) {
    console.error('Error fetching from ESPN:', err.message);
    // Try fallback
    await fetchFromMastersDirectly(poolData);
  }
}

async function fetchFromMastersDirectly(poolData) {
  console.log('Trying Masters.com data...');
  try {
    const response = await fetch('https://www.masters.com/en_US/scores/feeds/2025/scores.json');
    const text = await response.text();
    const data = JSON.parse(text);
    
    if (data && data.data && data.data.player) {
      const scores = {};
      data.data.player.forEach(player => {
        const fullName = `${player.first_name} ${player.last_name}`.trim();
        const matchedGolfer = poolData.golfers.find(g => {
          const mastersName = fullName.toLowerCase();
          const ourName = g.name.toLowerCase();
          return mastersName === ourName ||
                 mastersName.includes(ourName.split(' ').pop()) ||
                 ourName.includes(mastersName.split(' ').pop());
        });
        
        if (matchedGolfer) {
          const totalScore = parseScore(player.topar);
          scores[matchedGolfer.id] = {
            displayName: fullName,
            totalScore,
            currentRound: parseInt(player.round) || 1,
            madeCut: player.status !== 'C',
            status: player.status || 'active',
            position: player.pos || '--',
            roundScores: [player.round1, player.round2, player.round3, player.round4].filter(Boolean),
            withdrawn: player.status === 'W' || player.status === 'DQ'
          };
        }
      });
      
      poolData.scores = scores;
      poolData.tournamentStarted = Object.keys(scores).length > 0;
      poolData.lastUpdated = new Date().toISOString();
      fs.writeFileSync(POOL_DATA_FILE, JSON.stringify(poolData, null, 2));
      console.log(`Updated ${Object.keys(scores).length} scores from Masters.com`);
    }
  } catch (err) {
    console.error('Masters.com fallback also failed:', err.message);
  }
}

function parseScore(scoreStr) {
  if (scoreStr === null || scoreStr === undefined) return null;
  if (typeof scoreStr === 'number') return scoreStr;
  const s = String(scoreStr).trim();
  if (s === 'E' || s === 'Even') return 0;
  if (s === '--' || s === '') return null;
  const num = parseInt(s.replace('+', ''));
  return isNaN(num) ? null : num;
}

fetchScores().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

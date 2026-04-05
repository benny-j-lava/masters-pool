#!/usr/bin/env node

/**
 * Masters Pool Score Fetcher
 * Runs via GitHub Actions every 30 minutes during tournament hours.
 * Fetches live scores from ESPN's Golf API and updates pool-data.json.
 *
 * ESPN API structure (verified against live Valero data Apr 5 2026):
 *   data.events[] — active events on the PGA tour scoreboard
 *   event.competitions[0].competitors[] — players in the field
 *   competitor.athlete.displayName — player name
 *   competitor.score — to-par total as string: "-15", "E", "+2"
 *   competitor.linescores[] — one entry per round that has begun:
 *     {
 *       period: 1|2|3|4,         — round number
 *       displayValue: "-6",       — to-par for that round (USE THIS, not value)
 *       value: 66.0,              — cumulative stroke total mid-round (unreliable)
 *       linescores: [...]         — hole-by-hole entries (length = holes played)
 *     }
 *   Cut detection: missed-cut players simply have no period 3 linescore.
 *   ESPN publishes R3 tee times Friday night, so by Saturday morning
 *   anyone without a period 3 entry genuinely missed the cut.
 */

const fs = require('fs');
const path = require('path');

const POOL_DATA_FILE = path.join(__dirname, 'pool-data.json');
const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
const MASTERS_COM_URL = 'https://www.masters.com/en_US/scores/feeds/2026/scores.json';

async function fetchScores() {
  console.log('Fetching Masters scores from ESPN...');

  let poolData = JSON.parse(fs.readFileSync(POOL_DATA_FILE, 'utf8'));

  if (!poolData.drawCompleted || poolData.assignments.length === 0) {
    console.log('Draw not yet completed. Skipping score fetch.');
    return;
  }

  try {
    const response = await fetch(ESPN_URL);
    const data = await response.json();

    let mastersEvent = null;
    if (data.events) {
      mastersEvent = data.events.find(e =>
        e.name && (
          e.name.toLowerCase().includes('masters') ||
          e.shortName?.toLowerCase().includes('masters')
        )
      );
    }

    if (!mastersEvent) {
      console.log('Masters event not found in ESPN data. Available events:');
      (data.events || []).forEach(e => console.log(' -', e.name));
      await fetchFromMastersCom(poolData);
      return;
    }

    console.log(`Found event: ${mastersEvent.name}`);

    const competition = (mastersEvent.competitions || [])[0];
    if (!competition) {
      console.log('No competition data found.');
      return;
    }

    const competitors = competition.competitors || [];
    const scores = {};
    let tournamentStarted = false;

    competitors.forEach(player => {
      const playerName = player.athlete?.displayName || player.athlete?.fullName;
      if (!playerName) return;

      // Total to-par score as a string: "-15", "E", "+2"
      const totalScore = parseScore(player.score);
      if (totalScore !== null) tournamentStarted = true;

      // Build per-round data. For each round linescore:
      //   displayValue = to-par for that round, e.g. "-6" (reliable, even mid-round)
      //   linescores.length = holes played in that round
      const roundData = {};
      (player.linescores || []).forEach(ls => {
        const round = ls.period;
        if (round < 1 || round > 4) return;
        roundData[round] = {
          toPar: ls.displayValue,          // e.g. "-6", "E", "+2", "-" if not started
          holesPlayed: ls.linescores?.length ?? 0
        };
      });

      // roundScores array [R1, R2, R3, R4] — to-par string or null
      const roundScores = [1, 2, 3, 4].map(r => roundData[r]?.toPar ?? null);

      // Current round and thru (holes played in the active round)
      const roundsStarted = [1, 2, 3, 4].filter(r => roundData[r]);
      const currentRound = roundsStarted.length;
      const activeRound = roundsStarted[roundsStarted.length - 1];
      const holesPlayed = activeRound ? (roundData[activeRound]?.holesPlayed ?? 0) : 0;
      const thru = holesPlayed === 18 ? 'F' : holesPlayed === 0 ? '-' : String(holesPlayed);

      // Cut detection: if a player has a period 3 linescore they made the cut.
      // ESPN assigns R3 tee times (and thus a period 3 entry) Friday night after
      // the cut is made. Anyone without one missed it.
      const statusName = player.status?.type?.name || '';
      const withdrawn = statusName.includes('WD') || statusName.includes('DQ');
      const hasR3Entry = !!roundData[3];
      const madeCut = withdrawn ? false : hasR3Entry;

      const matchedGolfer = findGolfer(poolData.golfers, playerName);
      if (matchedGolfer) {
        scores[matchedGolfer.id] = {
          displayName: playerName,
          totalScore,
          currentRound,
          thru,
          madeCut,
          withdrawn,
          status: statusName || 'active',
          roundScores  // ["-2", "+3", null, null] etc.
        };
      }
    });

    const matchCount = Object.keys(scores).length;
    poolData.scores = scores;
    poolData.tournamentStarted = tournamentStarted;
    poolData.lastUpdated = new Date().toISOString();

    fs.writeFileSync(POOL_DATA_FILE, JSON.stringify(poolData, null, 2));
    console.log(`Updated scores for ${matchCount} of ${poolData.golfers.length} pool golfers.`);

    if (matchCount < poolData.golfers.length) {
      const missing = poolData.golfers.filter(g => !scores[g.id]);
      console.log('Unmatched pool golfers (check name spelling):');
      missing.forEach(g => console.log(` - ${g.name}`));
    }

  } catch (err) {
    console.error('Error fetching from ESPN:', err.message);
    await fetchFromMastersCom(poolData);
  }
}

async function fetchFromMastersCom(poolData) {
  console.log('Trying Masters.com fallback...');
  try {
    const response = await fetch(MASTERS_COM_URL);
    const data = await response.json();

    if (data && data.data && data.data.player) {
      const scores = {};
      data.data.player.forEach(player => {
        const fullName = `${player.first_name} ${player.last_name}`.trim();
        const matchedGolfer = findGolfer(poolData.golfers, fullName);
        if (matchedGolfer) {
          scores[matchedGolfer.id] = {
            displayName: fullName,
            totalScore: parseScore(player.topar),
            currentRound: parseInt(player.round) || 1,
            thru: player.thru || '-',
            madeCut: player.status !== 'C',
            withdrawn: player.status === 'W' || player.status === 'DQ',
            status: player.status || 'active',
            roundScores: [player.round1, player.round2, player.round3, player.round4]
              .map(r => (r && r !== '--') ? r : null)
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

/**
 * Match an ESPN player name to our pool golfer list.
 * Tries exact match first, then last-name fallback.
 */
function findGolfer(golfers, espnName) {
  const espnLower = espnName.toLowerCase().trim();
  let match = golfers.find(g => g.name.toLowerCase().trim() === espnLower);
  if (match) return match;
  const espnLast = espnLower.split(' ').pop();
  match = golfers.find(g => g.name.toLowerCase().split(' ').pop() === espnLast);
  return match || null;
}

/**
 * Parse a to-par string to a number.
 * "-15" => -15, "E" => 0, "+2" => 2, "--" => null
 */
function parseScore(scoreStr) {
  if (scoreStr === null || scoreStr === undefined) return null;
  if (typeof scoreStr === 'number') return scoreStr;
  const s = String(scoreStr).trim();
  if (s === 'E' || s === 'Even') return 0;
  if (s === '--' || s === '' || s === '-') return null;
  const num = parseInt(s.replace('+', ''));
  return isNaN(num) ? null : num;
}

fetchScores().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

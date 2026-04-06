#!/usr/bin/env node

/**
 * Masters Pool Draw Runner
 * Triggered by GitHub Actions at 8:00 PM ET on April 7.
 * Shuffles golfers, assigns one to each team, and writes
 * the result back to pool-data.json with drawCompleted: true.
 */

const fs = require('fs');
const path = require('path');

const POOL_DATA_FILE = path.join(__dirname, 'pool-data.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');

function runDraw() {
  const poolData = JSON.parse(fs.readFileSync(POOL_DATA_FILE, 'utf8'));
  const teams = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));

  if (poolData.drawCompleted && poolData.assignments?.length > 0) {
    console.log('Draw already completed. Skipping.');
    return;
  }

  // Fisher-Yates shuffle for a fair draw
  const golfers = [...poolData.golfers];
  for (let i = golfers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [golfers[i], golfers[j]] = [golfers[j], golfers[i]];
  }

  // Assign first N golfers to the N teams
  const assignments = teams.map((team, i) => ({
    teamId: team.id,
    golferId: golfers[i].id
  }));

  poolData.assignments = assignments;
  poolData.drawCompleted = true;
  poolData.drawRunAt = new Date().toISOString();

  fs.writeFileSync(POOL_DATA_FILE, JSON.stringify(poolData, null, 2));

  console.log('Draw complete!');
  assignments.forEach(a => {
    const team = teams.find(t => t.id === a.teamId);
    const golfer = poolData.golfers.find(g => g.id === a.golferId);
    console.log(` ${team.manager} (${team.teamName}) → ${golfer.name}`);
  });
}

runDraw();

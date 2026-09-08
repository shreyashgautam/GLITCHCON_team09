const crypto = require('crypto');

let chain = [];
let io = null;

function ensureGenesis() {
  if (chain.length === 0) {
    chain.push({
      index: 0,
      timestamp: new Date().toISOString(),
      action: 'CHAIN_INITIALIZED',
      actorId: 'SYSTEM',
      patientId: null,
      details: 'Kathir Memorial Hospital — Patient Intelligence Blockchain Audit Ledger initialized',
      previousHash: '0000000000000000',
      hash: crypto.createHash('sha256').update('genesis').digest('hex')
    });
  }
}

function init(socketIo) {
  io = socketIo;
  ensureGenesis();
}

function addBlock(action, actorId, patientId, details) {
  ensureGenesis();
  const prevHash = chain[chain.length - 1]?.hash || '0000000000000000';
  const blockData = {
    index: chain.length,
    timestamp: new Date().toISOString(),
    action,
    actorId,
    patientId,
    details,
    previousHash: prevHash
  };
  blockData.hash = crypto.createHash('sha256').update(JSON.stringify(blockData)).digest('hex');
  chain.push(blockData);
  if (io) io.emit('new_block', blockData);
  return blockData;
}

function getChain() {
  return chain;
}

function verifyChain() {
  for (let i = 1; i < chain.length; i++) {
    const block = chain[i];
    const { hash, ...rest } = block;
    const recalculated = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    if (recalculated !== hash) return { valid: false, failedAt: i };
    if (block.previousHash !== chain[i - 1].hash) return { valid: false, failedAt: i };
  }
  return { valid: true, blocks: chain.length };
}

function exportCSV() {
  const header = 'Index,Timestamp,Action,Actor,PatientID,Details,Hash\n';
  const rows = chain.map(b =>
    `${b.index},"${b.timestamp}","${b.action}","${b.actorId}","${b.patientId || ''}","${b.details}","${b.hash.substring(0, 16)}..."`
  ).join('\n');
  return header + rows;
}

module.exports = { init, addBlock, getChain, verifyChain, exportCSV };

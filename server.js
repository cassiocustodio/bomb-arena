'use strict';
/*
 * Bomb Arena — servidor autoritativo (Fase 3)
 *
 * A simulação inteira (mapa, movimento, bombas, encolhimento, power-ups,
 * maldições, IA dos bots) é a MESMA lógica do protótipo local — só que
 * rodando aqui no servidor, por sala, em vez de no navegador de cada um.
 * O cliente manda só o input (direção + "colocar bomba") e desenha o que
 * o servidor mandar de volta a cada tick.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { MM_CFG, findMatches } = require('./matchmaking');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

/* ==================== CONFIG (igual ao protótipo) ==================== */
const CFG = {
  cols: 13, rows: 11,
  roundTime: 90,
  shrinkStart: 60,
  ringInterval: 10,
  warnDuration: 3,
  ringsToRemove: 3,
  bombFuse: 4,
  explosionDuration: 0.5,
  baseSpeed: 3.3,
  speedPerLevel: 0.5,
  powerupChance: 0.35,
  tickRate: 30, // atualizações por segundo que o servidor simula e transmite
  botChaseRange: 6,
  buffDuration: 10,             // duração do Bomb Pass e do Escudo
  curseDuration: 10,            // duração de qualquer maldição
  curseAutobombInterval: 0.35,  // intervalo entre cada bomba da sequência forçada
  curseAutobombSequenceSize: 4, // quantas bombas em sequência antes da pausa
  curseAutobombPause: 1,        // pausa (s) entre uma sequência e a próxima
  fastFuseMultiplier: 0.5       // maldição "pavio curto": fração do tempo normal de pavio
};
const EMPTY = 0, WALL = 1, BLOCK = 2;
const DIRS4 = [[1,0],[-1,0],[0,1],[0,-1]];
const PLAYER_COLORS = ['#4f7cff', '#ff6b6b', '#3ddc84', '#ffd23f'];
const BOT_TAG_COLOR = '#9b5de5'; // só usado se sobrar mais de uma cor pra bot (raro com 4 max)

/* ==================== STICKERS ====================
   Catálogo central. "tier":
   - 'standard': todo mundo já possui, não precisa checar posse.
   - 'premium' : só quem tiver o id em entity.ownedStickers (colecionável/comprado/conquistado).
   O id é o mesmo nome do arquivo em public/stickers/<id>.webp, sem extensão. */
const STICKER_CATALOG = [
  { id:'bravo', name:'Bravo!', tier:'standard' },
  { id:'raiva', name:'Raiva!', tier:'standard' }
  // adesivos premium futuros entram aqui, ex:
  // { id:'confete', name:'Confete', tier:'premium' }
];
const STICKER_COOLDOWN_MS = 1200; // intervalo mínimo entre um envio e outro, por jogador

const CHARACTER_CATALOG = [
  { id:'hero', name:'Hero', tier:'standard' }
  // { id:'volt', name:'Volt', tier:'premium' }  // adicione aqui quando processar o personagem novo
];
const DEFAULT_CHARACTER = 'hero';

function findCharacter(id){
  for(var i=0;i<CHARACTER_CATALOG.length;i++){ if(CHARACTER_CATALOG[i].id===id) return CHARACTER_CATALOG[i]; }
  return null;
}
function playerOwnsCharacter(entity, id){
  var c = findCharacter(id);
  if(!c) return false;
  return entity.ownedCharacters.indexOf(id) !== -1;
}

function findSticker(id){
  for(var i=0;i<STICKER_CATALOG.length;i++){ if(STICKER_CATALOG[i].id===id) return STICKER_CATALOG[i]; }
  return null;
}
function playerOwnsSticker(entity, id){
  var s = findSticker(id);
  if(!s) return false;
  return entity.ownedStickers.indexOf(id) !== -1;
}

/* ==================== TEMA VISUAL (a paleta/textura em si é só do cliente;
   o servidor só decide QUAL tema vale pra rodada, pra todo mundo ver o mesmo) */
const THEMES = ['classic', 'ice', 'cave'];
function pickTheme(){ return THEMES[Math.floor(Math.random()*THEMES.length)]; }

/* ==================== MAPA ==================== */
function cornerSpawns(){
  return [
    {x:1, y:1},
    {x:CFG.cols-2, y:CFG.rows-2},
    {x:CFG.cols-2, y:1},
    {x:1, y:CFG.rows-2}
  ];
}
function cornerClearCells(c){
  var dx = c.x===1 ? 1 : -1;
  var dy = c.y===1 ? 1 : -1;
  return [[c.x,c.y],[c.x+dx,c.y],[c.x,c.y+dy]];
}
function generateMap(maxPlayers){
  var g = [];
  for(var y=0;y<CFG.rows;y++){
    var row = [];
    for(var x=0;x<CFG.cols;x++){
      var cell = EMPTY;
      if(x===0 || y===0 || x===CFG.cols-1 || y===CFG.rows-1){ cell = WALL; }
      else if(x%2===0 && y%2===0){ cell = WALL; }
      row.push(cell);
    }
    g.push(row);
  }
  var activeSpawns = cornerSpawns().slice(0, maxPlayers);
  var clearCells = [];
  activeSpawns.forEach(function(c){ clearCells = clearCells.concat(cornerClearCells(c)); });
  clearCells.forEach(function(c){ g[c[1]][c[0]] = EMPTY; });
  for(var yy=1; yy<CFG.rows-1; yy++){
    for(var xx=1; xx<CFG.cols-1; xx++){
      if(g[yy][xx] !== EMPTY) continue;
      var isClear = clearCells.some(function(c){ return c[0]===xx && c[1]===yy; });
      if(isClear) continue;
      if(Math.random() < 0.68){ g[yy][xx] = BLOCK; }
    }
  }
  return g;
}
function ringOf(x,y){
  return Math.min(x, CFG.cols-1-x, y, CFG.rows-1-y);
}

/* ==================== ENTIDADES ==================== */
function newEntity(id, x, y, color, isBot){
  return {
    id: id, color: color, isBot: !!isBot,
    x: x, y: y, r: 0.33,
    axis: 'x', moveDir: 0, facing: {x:0,y:1},
    bombLevel:0, fireLevel:0, speedLevel:0,
    maxBombs:1, fireRange:1,
    bombPass:false, bombPassTimer:0,
    shieldActive:false, shieldTimer:0,
    curse:null, curseTimer:0, curseSeq:null,
    alive:true, deathTimer:0, deathReason:'',
    ownedStickers: STICKER_CATALOG.filter(function(s){ return s.tier==='standard'; }).map(function(s){ return s.id; }), lastStickerAt: 0,
    userId: null, nickname: null, characterId: DEFAULT_CHARACTER, // preenchidos se estiver logado; null = convidado
    ownedCharacters: CHARACTER_CATALOG.filter(function(c){ return c.tier==='standard'; }).map(function(c){ return c.id; }),
    input: isBot ? null : {ix:0, iy:0},
    ai: isBot ? {decisionTimer:0, ix:0, iy:0} : null
  };
}
function resetEntityForMatch(entity, x, y){
  entity.x=x; entity.y=y; entity.axis='x'; entity.moveDir=0; entity.facing={x:0,y:1};
  entity.bombLevel=0; entity.fireLevel=0; entity.speedLevel=0;
  entity.maxBombs=1; entity.fireRange=1;
  entity.bombPass=false; entity.bombPassTimer=0;
  entity.shieldActive=false; entity.shieldTimer=0;
  entity.curse=null; entity.curseTimer=0; entity.curseSeq=null;
  entity.alive=true; entity.deathTimer=0; entity.deathReason='';
  if(entity.input) entity.input = {ix:0, iy:0};
  if(entity.ai) entity.ai = {decisionTimer:0, ix:0, iy:0};
}
function findEntity(room, id){
  for(var i=0;i<room.entities.length;i++){ if(room.entities[i].id===id) return room.entities[i]; }
  return null;
}

/* ==================== COLISÃO E MOVIMENTO ==================== */
function isSolidCell(room, gx, gy, mover){
  if(gx<0 || gy<0 || gx>=CFG.cols || gy>=CFG.rows) return true;
  var c = room.grid[gy][gx];
  if(c===WALL || c===BLOCK) return true;
  for(var i=0;i<room.bombs.length;i++){
    var b = room.bombs[i];
    if(b.exploded || b.gx!==gx || b.gy!==gy) continue;
    if(mover && mover.bombPass) continue;
    if(b.blocksOwner) return true;
    if(!mover || mover.id !== b.ownerId) return true;
  }
  return false;
}
function canMove(room, entity, dir){
  if(dir.x===0 && dir.y===0) return true;
  var gx = Math.floor(entity.x), gy = Math.floor(entity.y);
  return !isSolidCell(room, gx+dir.x, gy+dir.y, entity);
}
function inputToDir(ix, iy, currentAxis){
  if(ix===0 && iy===0) return {x:0, y:0};
  var ax = Math.abs(ix), ay = Math.abs(iy);
  if(ax > ay) return {x: ix>0?1:-1, y:0};
  if(ay > ax) return {x:0, y: iy>0?1:-1};
  if(currentAxis==='x' && iy!==0) return {x:0, y: iy>0?1:-1};
  if(currentAxis==='y' && ix!==0) return {x: ix>0?1:-1, y:0};
  return ix!==0 ? {x: ix>0?1:-1, y:0} : {x:0, y: iy>0?1:-1};
}
function boxOverlapsCell(x,y,r,gx,gy){
  return (x+r > gx) && (x-r < gx+1) && (y+r > gy) && (y-r < gy+1);
}
function stepEntityMovement(room, entity, ix, iy, speed, dt){
  var desired = inputToDir(ix, iy, entity.axis);

  if(desired.x===0 && desired.y===0){
    entity.moveDir = 0;
  } else {
    var desiredAxis = desired.x!==0 ? 'x' : 'y';
    var desiredSign = desired.x!==0 ? desired.x : desired.y;
    if(desiredAxis === entity.axis){
      entity.moveDir = desiredSign;
    } else if(canMove(room, entity, desired)){
      /* Virar de eixo exige alinhar a coordenada do eixo que está sendo
         deixado ao centro da célula (é isso que vira a "pista" do novo eixo).
         Antes, esse alinhamento era um teleporte instantâneo pro centro,
         não importava o quão longe dele o jogador estivesse — daí o
         "engasgo": ele parecia parar/recuar um instante antes de virar.
         Agora só viramos quando o jogador está perto o bastante do centro
         pra alcançá-lo neste próprio tick (ou já parado), senão a curva
         fica pendente e é concedida assim que ele passar pelo centro do
         corredor — sem precisar soltar e apertar a tecla de novo. */
      var pos = entity.axis==='x' ? entity.x : entity.y;
      var center = Math.floor(pos) + 0.5;
      var fwd = entity.moveDir;
      var tol = Math.max(speed*dt, 0.03);
      var aheadDist = fwd===0 ? 0 : (center-pos)*fwd; // >0: centro ainda à frente

      if(fwd===0 || Math.abs(aheadDist) <= tol){
        // No centro (ou bem perto, ou parado): vira liso, sem pulo perceptível.
        if(entity.axis==='x') entity.x = center; else entity.y = center;
        entity.axis = desiredAxis;
        entity.moveDir = desiredSign;
      } else if(aheadDist < 0){
        // Já passou do centro deste corredor. Só vale recuar até ele se não
        // houver como seguir em frente (travado contra parede); do contrário
        // deixa o jogador seguir até o próximo corredor e virar lá.
        var fwdDelta = entity.axis==='x' ? {x:fwd,y:0} : {x:0,y:fwd};
        var blockedAhead = !canMove(room, entity, fwdDelta);
        if(blockedAhead){
          // Já está parado/travado na parede: não há movimento em curso pra
          // interromper, então deslizar de volta ao centro (na mesma
          // velocidade) não gera soluço nem pulo visível.
          var maxStep = speed*dt;
          var newPos = fwd>0 ? Math.max(center, pos-maxStep) : Math.min(center, pos+maxStep);
          if(entity.axis==='x') entity.x = newPos; else entity.y = newPos;
          if(newPos===center){ entity.axis = desiredAxis; entity.moveDir = desiredSign; }
          return; // posição já resolvida neste tick
        }
      }
      // caso contrário (ainda em trânsito, sem estar travado): mantém o eixo
      // atual por enquanto, a virada será reavaliada no próximo tick.
    }
  }

  if(entity.moveDir!==0){
    if(entity.axis==='x'){ entity.facing.x=entity.moveDir; entity.facing.y=0; }
    else { entity.facing.x=0; entity.facing.y=entity.moveDir; }
  }
  if(entity.moveDir===0) return;

  var axis=entity.axis, dir=entity.moveDir, r=entity.r;
  var pos = axis==='x' ? entity.x : entity.y;
  var fixedOther = axis==='x' ? Math.floor(entity.y) : Math.floor(entity.x);
  var newPos = pos + dir*speed*dt;
  var leadingCell = Math.floor(newPos + dir*r);
  var gx = axis==='x' ? leadingCell : fixedOther;
  var gy = axis==='x' ? fixedOther : leadingCell;
  if(isSolidCell(room, gx, gy, entity)){
    var wallBoundary = dir>0 ? leadingCell : leadingCell+1;
    newPos = wallBoundary - dir*r;
  }
  if(axis==='x') entity.x = newPos; else entity.y = newPos;
}
function stepHumanEntity(room, entity, dt){
  var ix = entity.input.ix, iy = entity.input.iy;
  if(entity.curse==='reverse'){ ix=-ix; iy=-iy; }
  var speed = CFG.baseSpeed + entity.speedLevel*CFG.speedPerLevel;
  if(entity.curse==='slow') speed *= 0.4;
  stepEntityMovement(room, entity, ix, iy, speed, dt);
}

/* ==================== BOMBAS E EXPLOSÕES ==================== */
function placeBombFor(room, entity, forced){
  if(room.state!=='playing' || !entity.alive) return;
  var gx = Math.floor(entity.x), gy = Math.floor(entity.y);
  if(room.grid[gy][gx] !== EMPTY) return;
  if(!forced){
    var activeOwn = room.bombs.filter(function(b){ return !b.exploded && b.ownerId===entity.id; }).length;
    if(activeOwn >= entity.maxBombs) return;
  }
  for(var i=0;i<room.bombs.length;i++){
    var b = room.bombs[i];
    if(!b.exploded && b.gx===gx && b.gy===gy) return;
  }
  var fuse = (entity.curse==='fastfuse') ? CFG.bombFuse*CFG.fastFuseMultiplier : CFG.bombFuse;
  room.bombs.push({ gx:gx, gy:gy, timer:fuse, range:entity.fireRange, blocksOwner:false, exploded:false, ownerId:entity.id });
}
function destroyPowerupAt(room, gx, gy){
  var found = false;
  for(var i=room.powerups.length-1; i>=0; i--){
    if(room.powerups[i].gx===gx && room.powerups[i].gy===gy){ room.powerups.splice(i,1); found=true; }
  }
  return found;
}
function killEntitiesInCells(room, cells, reason){
  var justDied = [];
  for(var e=0; e<room.entities.length; e++){
    var ent = room.entities[e];
    if(!ent.alive) continue;
    if(reason==='blast' && ent.shieldActive) continue;
    var egx = Math.floor(ent.x), egy = Math.floor(ent.y);
    for(var k=0;k<cells.length;k++){
      if(cells[k].x===egx && cells[k].y===egy){
        if(killEntity(ent, reason)) justDied.push(ent.id);
        break;
      }
    }
  }
  if(justDied.length) room.deathOrder.push(justDied);
}
function explodeBomb(room, bomb){
  if(bomb.exploded) return;
  bomb.exploded = true;
  var cells = [{x:bomb.gx, y:bomb.gy}];
  destroyPowerupAt(room, bomb.gx, bomb.gy);
  for(var d=0; d<DIRS4.length; d++){
    for(var step=1; step<=bomb.range; step++){
      var cx = bomb.gx + DIRS4[d][0]*step;
      var cy = bomb.gy + DIRS4[d][1]*step;
      if(cx<0||cy<0||cx>=CFG.cols||cy>=CFG.rows) break;
      var ct = room.grid[cy][cx];
      if(ct===WALL) break;
      cells.push({x:cx, y:cy});
      if(ct===BLOCK){
        room.grid[cy][cx] = EMPTY;
        if(Math.random() < CFG.powerupChance){
          var types = ['bomb','fire','speed','bombpass','curse','shield'];
          var type = types[Math.floor(Math.random()*types.length)];
          room.powerups.push({ gx:cx, gy:cy, type:type });
        }
        break;
      }
      if(destroyPowerupAt(room, cx, cy)) break;
      for(var i=0;i<room.bombs.length;i++){
        var ob = room.bombs[i];
        if(!ob.exploded && ob.gx===cx && ob.gy===cy){ explodeBomb(room, ob); }
      }
    }
  }
  room.explosions.push({ cells:cells, t:0, duration:CFG.explosionDuration });
  killEntitiesInCells(room, cells, 'blast');
}
function updateBombs(room, dt){
  room.bombs.forEach(function(b){
    if(b.exploded) return;
    if(!b.blocksOwner){
      var owner = findEntity(room, b.ownerId);
      var ownerStillThere = owner && owner.alive && boxOverlapsCell(owner.x, owner.y, owner.r, b.gx, b.gy);
      if(!ownerStillThere) b.blocksOwner = true;
    }
    b.timer -= dt;
    if(b.timer<=0) explodeBomb(room, b);
  });
  room.bombs = room.bombs.filter(function(b){ return !b.exploded; });
}
function updateExplosions(room, dt){
  for(var i=room.explosions.length-1; i>=0; i--){
    room.explosions[i].t += dt;
    if(room.explosions[i].t >= room.explosions[i].duration) room.explosions.splice(i,1);
  }
}

/* ==================== ENCOLHIMENTO ==================== */
function isCellWarning(room, x, y){
  var r = ringOf(x,y);
  if(r===0) return false;
  var step = r-1;
  if(room.ringsVanished.has(r)) return false;
  if(step >= CFG.ringsToRemove) return false;
  var warnStart = CFG.shrinkStart + step*CFG.ringInterval;
  return room.elapsed >= warnStart && room.elapsed < warnStart + CFG.warnDuration;
}
function hardenCellToWall(room, gx, gy){
  room.bombs.forEach(function(b){ if(!b.exploded && b.gx===gx && b.gy===gy) explodeBomb(room, b); });
  destroyPowerupAt(room, gx, gy);
  room.grid[gy][gx] = WALL;
  var wallDeaths = [];
  room.entities.forEach(function(ent){
    if(ent.alive && boxOverlapsCell(ent.x, ent.y, ent.r, gx, gy)){
      if(killEntity(ent, 'wall')) wallDeaths.push(ent.id);
    }
  });
  if(wallDeaths.length) room.deathOrder.push(wallDeaths);
}
function vanishRing(room, r){
  for(var y=0;y<CFG.rows;y++){
    for(var x=0;x<CFG.cols;x++){
      if(ringOf(x,y) !== r) continue;
      hardenCellToWall(room, x, y);
    }
  }
}
function updateShrink(room){
  for(var step=0; step<CFG.ringsToRemove; step++){
    var r = step+1;
    if(room.ringsVanished.has(r)) continue;
    var warnStart = CFG.shrinkStart + step*CFG.ringInterval;
    var vanishAt = warnStart + CFG.warnDuration;
    if(room.elapsed >= vanishAt){
      room.ringsVanished.add(r);
      vanishRing(room, r);
    }
  }
}

/* ==================== POWER-UPS E MALDIÇÕES ==================== */
function applyPowerupTo(entity, type){
  if(type==='bomb'){ entity.bombLevel=Math.min(entity.bombLevel+1,5); entity.maxBombs=1+entity.bombLevel; }
  else if(type==='fire'){ entity.fireLevel=Math.min(entity.fireLevel+1,5); entity.fireRange=1+entity.fireLevel; }
  else if(type==='speed'){ entity.speedLevel=Math.min(entity.speedLevel+1,6); }
  else if(type==='bombpass'){ entity.bombPass=true; entity.bombPassTimer=CFG.buffDuration; }
  else if(type==='shield'){ entity.shieldActive=true; entity.shieldTimer=CFG.buffDuration; }
  else if(type==='curse'){
    var curses = ['reverse','slow','autobomb','fastfuse'];
    entity.curse = curses[Math.floor(Math.random()*curses.length)];
    entity.curseTimer = CFG.curseDuration;
    entity.curseSeq = null;
    // uma maldição cancela quaisquer buffs em vigor (Bomb Pass, Escudo)
    entity.bombPass = false; entity.bombPassTimer = 0;
    entity.shieldActive = false; entity.shieldTimer = 0;
  }
}
function checkPowerupPickup(room){
  room.entities.forEach(function(ent){
    if(!ent.alive) return;
    var gx = Math.floor(ent.x), gy = Math.floor(ent.y);
    for(var i=room.powerups.length-1; i>=0; i--){
      var p = room.powerups[i];
      if(p.gx===gx && p.gy===gy){
        applyPowerupTo(ent, p.type);
        room.powerups.splice(i,1);
      }
    }
  });
}
function checkCurseContagion(room){
  var ents = room.entities;
  for(var i=0; i<ents.length; i++){
    var a = ents[i];
    if(!a.alive || !a.curse) continue; // só entidades já amaldiçoadas contagiam
    for(var j=0; j<ents.length; j++){
      if(i===j) continue;
      var b = ents[j];
      if(!b.alive || b.curse) continue; // quem já tem maldição não pega outra

      var dx = a.x - b.x, dy = a.y - b.y;
      var dist = Math.sqrt(dx*dx + dy*dy);
      if(dist < a.r + b.r){ // "encostou"
        b.curse = a.curse;           // pega EXATAMENTE a mesma maldição
        b.curseTimer = CFG.curseDuration;
        b.curseSeq = null;
        // mesma regra do pickup normal: maldição cancela buffs em vigor
        b.bombPass = false; b.bombPassTimer = 0;
        b.shieldActive = false; b.shieldTimer = 0;
      }
    }
  }
}
function updateStatusEffects(room, dt){
  room.entities.forEach(function(ent){
    if(!ent.alive) return;

    if(ent.bombPass){
      ent.bombPassTimer -= dt;
      if(ent.bombPassTimer <= 0){ ent.bombPass=false; ent.bombPassTimer=0; }
    }
    if(ent.shieldActive){
      ent.shieldTimer -= dt;
      if(ent.shieldTimer <= 0){ ent.shieldActive=false; ent.shieldTimer=0; }
    }

    if(!ent.curse) return;
    ent.curseTimer -= dt;

    if(ent.curse==='autobomb'){
      // Sequência de N bombas (ignorando o limite normal), pausa, repete.
      if(!ent.curseSeq) ent.curseSeq = { phase:'placing', count:0, timer:0 };
      ent.curseSeq.timer -= dt;
      if(ent.curseSeq.timer <= 0){
        if(ent.curseSeq.phase==='placing'){
          placeBombFor(room, ent, true);
          ent.curseSeq.count++;
          if(ent.curseSeq.count >= CFG.curseAutobombSequenceSize){
            ent.curseSeq.phase='pausing'; ent.curseSeq.count=0; ent.curseSeq.timer=CFG.curseAutobombPause;
          } else {
            ent.curseSeq.timer = CFG.curseAutobombInterval;
          }
        } else {
          ent.curseSeq.phase='placing'; ent.curseSeq.timer=CFG.curseAutobombInterval;
        }
      }
    }

    if(ent.curseTimer <= 0){ ent.curse=null; ent.curseSeq=null; }
  });
}
function killEntity(entity, reason){
  if(!entity.alive) return false;
  entity.alive = false;
  entity.deathTimer = 0.9;
  entity.deathReason = reason;
  return true;
}

/* ==================== IA DOS BOTS ==================== */
function buildDangerMap(room){
  var danger = {};
  room.bombs.forEach(function(b){
    if(b.exploded) return;
    danger[b.gx+','+b.gy] = true;
    for(var d=0; d<DIRS4.length; d++){
      for(var step=1; step<=b.range; step++){
        var cx=b.gx+DIRS4[d][0]*step, cy=b.gy+DIRS4[d][1]*step;
        if(cx<0||cy<0||cx>=CFG.cols||cy>=CFG.rows) break;
        var ct = room.grid[cy][cx];
        if(ct===WALL) break;
        danger[cx+','+cy] = true;
        if(ct===BLOCK) break;
      }
    }
  });
  for(var y=0;y<CFG.rows;y++){
    for(var x=0;x<CFG.cols;x++){
      if(isCellWarning(room,x,y)) danger[x+','+y] = true;
    }
  }
  return danger;
}
function isDanger(x,y,dangerMap){ return !!dangerMap[x+','+y]; }
function bfsFirstStep(room, startX, startY, goalFn, passFn, maxNodes){
  maxNodes = maxNodes || 300;
  var key = function(x,y){ return x+','+y; };
  var visited = {};
  visited[key(startX,startY)] = true;
  var queue = [{x:startX,y:startY,first:null}];
  var head=0, visitedCount=0;
  while(head<queue.length && visitedCount<maxNodes){
    var cur = queue[head++];
    visitedCount++;
    for(var i=0;i<DIRS4.length;i++){
      var nx=cur.x+DIRS4[i][0], ny=cur.y+DIRS4[i][1];
      var k = key(nx,ny);
      if(visited[k]) continue;
      if(nx<0||ny<0||nx>=CFG.cols||ny>=CFG.rows) continue;
      if(!passFn(nx,ny)) continue;
      visited[k] = true;
      var first = cur.first || {x:DIRS4[i][0], y:DIRS4[i][1]};
      if(goalFn(nx,ny)) return first;
      queue.push({x:nx,y:ny,first:first});
    }
  }
  return null;
}
function hasLineOfFire(room, fromGx, fromGy, toGx, toGy, range){
  if(fromGx!==toGx && fromGy!==toGy) return false;
  var dx = Math.sign(toGx-fromGx), dy = Math.sign(toGy-fromGy);
  var dist = Math.max(Math.abs(toGx-fromGx), Math.abs(toGy-fromGy));
  if(dist===0 || dist>range) return false;
  for(var step=1; step<dist; step++){
    var cx=fromGx+dx*step, cy=fromGy+dy*step;
    var ct = room.grid[cy][cx];
    if(ct===WALL || ct===BLOCK) return false;
  }
  return true;
}
function cellNeighborsCrate(room, x, y){
  for(var i=0;i<DIRS4.length;i++){
    var nx=x+DIRS4[i][0], ny=y+DIRS4[i][1];
    if(nx<0||ny<0||nx>=CFG.cols||ny>=CFG.rows) continue;
    if(room.grid[ny][nx]===BLOCK) return true;
  }
  return false;
}
function fleeDirection(room, bot, dangerMap){
  var gx=Math.floor(bot.x), gy=Math.floor(bot.y);
  var passSafe = function(x,y){ return !isSolidCell(room,x,y,bot); };
  var goalSafe = function(x,y){ return !isDanger(x,y,dangerMap); };
  var step = bfsFirstStep(room, gx, gy, goalSafe, passSafe, 300);
  return step || {x:0,y:0};
}
function hasEscapeAfterBomb(room, bot, gx, gy, range){
  var danger = buildDangerMap(room);
  danger[gx+','+gy] = true;
  for(var d=0; d<DIRS4.length; d++){
    for(var step=1; step<=range; step++){
      var cx=gx+DIRS4[d][0]*step, cy=gy+DIRS4[d][1]*step;
      if(cx<0||cy<0||cx>=CFG.cols||cy>=CFG.rows) break;
      var ct = room.grid[cy][cx];
      if(ct===WALL) break;
      danger[cx+','+cy] = true;
      if(ct===BLOCK) break;
    }
  }
  var passSafe = function(x,y){ return !isSolidCell(room,x,y,bot); };
  var goalSafe = function(x,y){ return !isDanger(x,y,danger); };
  return bfsFirstStep(room, gx, gy, goalSafe, passSafe, 300) !== null;
}
function randomOpenStep(room, gx, gy, dangerMap){
  var dirs = DIRS4.slice();
  for(var i=dirs.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=dirs[i]; dirs[i]=dirs[j]; dirs[j]=t; }
  for(var k=0;k<dirs.length;k++){
    var nx=gx+dirs[k][0], ny=gy+dirs[k][1];
    if(ny<0||ny>=CFG.rows||nx<0||nx>=CFG.cols) continue;
    if(room.grid[ny][nx]!==EMPTY) continue;
    if(dangerMap && isDanger(nx,ny,dangerMap)) continue;
    return {x:dirs[k][0], y:dirs[k][1]};
  }
  return {x:0,y:0};
}
function rivalsOf(room, self){
  return room.entities.filter(function(e){ return e!==self && e.alive; });
}
function nearestRival(gx,gy,rivals){
  var best=null, bestDist=Infinity;
  for(var i=0;i<rivals.length;i++){
    var r=rivals[i];
    var d=Math.abs(Math.floor(r.x)-gx)+Math.abs(Math.floor(r.y)-gy);
    if(d<bestDist){ bestDist=d; best=r; }
  }
  return best;
}
function decideBotMove(room, bot){
  var gx=Math.floor(bot.x), gy=Math.floor(bot.y);
  var danger = buildDangerMap(room);

  if(isDanger(gx,gy,danger)){
    var away = fleeDirection(room, bot, danger);
    bot.ai.ix=away.x; bot.ai.iy=away.y;
    return;
  }

  var passSafe = function(x,y){ return !isSolidCell(room,x,y,bot) && !isDanger(x,y,danger); };
  var rivals = rivalsOf(room, bot);
  var activeOwn = room.bombs.filter(function(b){ return !b.exploded && b.ownerId===bot.id; }).length;

  if(activeOwn < bot.maxBombs){
    var canSnipe = rivals.some(function(r){
      return hasLineOfFire(room, gx, gy, Math.floor(r.x), Math.floor(r.y), bot.fireRange);
    });
    if(canSnipe && hasEscapeAfterBomb(room, bot, gx, gy, bot.fireRange)){
      placeBombFor(room, bot);
      var away2 = fleeDirection(room, bot, buildDangerMap(room));
      bot.ai.ix=away2.x; bot.ai.iy=away2.y;
      return;
    }
  }

  if(room.powerups.length > 0){
    var goalPowerup = function(x,y){
      for(var i=0;i<room.powerups.length;i++){ if(room.powerups[i].gx===x && room.powerups[i].gy===y) return true; }
      return false;
    };
    var toPowerup = bfsFirstStep(room, gx, gy, goalPowerup, passSafe, 300);
    if(toPowerup){ bot.ai.ix=toPowerup.x; bot.ai.iy=toPowerup.y; return; }
  }

  var target = nearestRival(gx, gy, rivals);
  var targetDist = target ? Math.abs(Math.floor(target.x)-gx) + Math.abs(Math.floor(target.y)-gy) : Infinity;
  if(target && targetDist <= CFG.botChaseRange){
    var tgx=Math.floor(target.x), tgy=Math.floor(target.y);
    var goalRival = function(x,y){ return x===tgx && y===tgy; };
    var chase = bfsFirstStep(room, gx, gy, goalRival, passSafe, 300);
    if(chase){ bot.ai.ix=chase.x; bot.ai.iy=chase.y; return; }
  }

  var neighborsCrate = function(x,y){ return cellNeighborsCrate(room,x,y); };
  if(neighborsCrate(gx,gy)){
    if(activeOwn < bot.maxBombs && hasEscapeAfterBomb(room, bot, gx, gy, bot.fireRange)){
      placeBombFor(room, bot);
      var away3 = fleeDirection(room, bot, buildDangerMap(room));
      bot.ai.ix=away3.x; bot.ai.iy=away3.y;
    } else {
      bot.ai.ix=0; bot.ai.iy=0;
    }
    return;
  }
  var toCrate = bfsFirstStep(room, gx, gy, neighborsCrate, passSafe, 300);
  if(toCrate){ bot.ai.ix=toCrate.x; bot.ai.iy=toCrate.y; return; }

  if(target){
    var tgx2=Math.floor(target.x), tgy2=Math.floor(target.y);
    var goalRivalFar = function(x,y){ return x===tgx2 && y===tgy2; };
    var chaseFar = bfsFirstStep(room, gx, gy, goalRivalFar, passSafe, 300);
    if(chaseFar){ bot.ai.ix=chaseFar.x; bot.ai.iy=chaseFar.y; return; }
  }

  var wander = randomOpenStep(room, gx, gy, danger);
  bot.ai.ix=wander.x; bot.ai.iy=wander.y;
}
function updateBot(room, bot, dt){
  bot.ai.decisionTimer -= dt;
  if(bot.ai.decisionTimer <= 0){
    bot.ai.decisionTimer = 0.15 + Math.random()*0.05;
    decideBotMove(room, bot);
  }
  var ix=bot.ai.ix, iy=bot.ai.iy;
  if(bot.curse==='reverse'){ ix=-ix; iy=-iy; }
  var speed = CFG.baseSpeed + bot.speedLevel*CFG.speedPerLevel;
  if(bot.curse==='slow') speed *= 0.4;
  stepEntityMovement(room, bot, ix, iy, speed, dt);
}

/* ==================== SALAS ==================== */
var rooms = new Map(); // code -> room

function makeRoomCode(){
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I pra evitar confusão
  var code;
  do {
    code = '';
    for(var i=0;i<4;i++) code += chars[Math.floor(Math.random()*chars.length)];
  } while(rooms.has(code));
  return code;
}

function createRoomObj(code, maxPlayers){
  return {
    code: code,
    maxPlayers: maxPlayers,
    sockets: new Map(),   // socketId -> entity
    entities: [],
    hostSocketId: null,
    state: 'lobby',       // lobby | playing | ended
    locked: false,        // true = sala de matchmaking (não aceita entrada por código)
    grid: null,
    bombs: [], explosions: [], powerups: [],
    ringsVanished: new Set(),
    deathOrder: [], // grupos de ids que morreram juntos, do mais antigo pro mais recente
    elapsed: 0,
    tickHandle: null,
    lastTickAt: null
  };
}

function socketRoom(socket){
  var code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function broadcastLobby(room){
  var players = [];
  room.sockets.forEach(function(entity, socketId){
    players.push({ id: socketId, color: entity.color, isHost: socketId===room.hostSocketId, nickname: entity.nickname });
  });
  io.to(room.code).emit('lobbyUpdate', { code: room.code, maxPlayers: room.maxPlayers, players: players });
}

async function getPlayerAccount(accessToken){
  if(!accessToken) return null; // sem token = convidado

  var authRes = await supabaseAdmin.auth.getUser(accessToken);
  if(authRes.error || !authRes.data || !authRes.data.user){
    //console.log('[conta] token inválido:', authRes.error && authRes.error.message);
    return null;
  }

  var userId = authRes.data.user.id;
  var profileRes = await supabaseAdmin
    .from('profiles')
    .select('nickname, owned_stickers, coins, wins, matches_played, skill_rating_2p, skill_rating_4p, owned_characters, selected_character')
    .eq('id', userId)
    .single();
  if(profileRes.error || !profileRes.data){
    //console.log('[conta] perfil não encontrado para', userId, '-', profileRes.error && profileRes.error.message);
    return null;
  }

  //console.log('[conta] logado com sucesso como:', profileRes.data.nickname);
  return {
    userId: userId,
    nickname: profileRes.data.nickname,
    skillRating: { 2: profileRes.data.skill_rating_2p, 4: profileRes.data.skill_rating_4p },
    ownedStickers: profileRes.data.owned_stickers || [],
    ownedCharacters: profileRes.data.owned_characters || ['hero'],
    selectedCharacter: profileRes.data.selected_character || 'hero'    
  };
}

// Coloca o socket na sala (síncrono). Usado pela entrada por código e pelo
// matchmaking. Devolve o payload que o cliente recebe ao entrar.
function attachPlayer(room, socket, account){
  socket.join(room.code);
  socket.data.roomCode = room.code;
  var color = PLAYER_COLORS[room.sockets.size % PLAYER_COLORS.length];
  var entity = newEntity(socket.id, 1.5, 1.5, color, false);

  if(account){
    entity.userId = account.userId;
    entity.nickname = account.nickname;
    entity.ownedStickers = account.ownedStickers;
    entity.ownedCharacters = account.ownedCharacters;
    if(playerOwnsCharacter(entity, account.selectedCharacter)){
      entity.characterId = account.selectedCharacter;
    }
  }

  room.sockets.set(socket.id, entity);
  room.entities.push(entity);
  if(!room.hostSocketId) room.hostSocketId = socket.id;
  return {
    ok: true, code: room.code, you: socket.id,
    isHost: room.hostSocketId === socket.id, maxPlayers: room.maxPlayers,
    stickers: STICKER_CATALOG, ownedStickers: entity.ownedStickers,
    characters: CHARACTER_CATALOG, ownedCharacters: entity.ownedCharacters,
    characterId: entity.characterId
  };
}

async function joinRoomSocket(room, socket, cb, accessToken){
  try {
    var account = await getPlayerAccount(accessToken);

    // O jogador pode ter saído/desconectado enquanto consultávamos o Supabase
    if(!socket.connected){ return; }
    // A sala pode ter sido encerrada, iniciada ou lotada durante a espera
    if(rooms.get(room.code) !== room || room.state !== 'lobby' || room.sockets.size >= room.maxPlayers){
      if(cb) cb({ ok:false, error:'Sala indisponível.' });
      return;
    }

    var payload = attachPlayer(room, socket, account);
    if(cb) cb(payload);
    broadcastLobby(room);
  } catch(err){
    console.error('[joinRoom] erro:', err);
    if(cb) cb({ ok:false, error:'Não foi possível entrar na sala. Tente de novo.' });
  }
}

/* ==================== MATCHMAKING ====================
   Fila por modo (2 ou 4 jogadores). A cada MM_CFG.tickMs o servidor tenta
   formar partidas com jogadores de Skill Rating parecido (a tolerância
   aumenta com a espera; passado botFillAfterMs completa com bots).
   A decisão de quem joga com quem está em matchmaking.js. */
var mmQueues = { 2: [], 4: [] };
var mmTokenSeq = 0;

function removeFromQueue(socket){
  socket.data.mmToken = null; // invalida qualquer findMatch ainda esperando o Supabase
  [2, 4].forEach(function(size){
    mmQueues[size] = mmQueues[size].filter(function(t){ return t.socket !== socket; });
  });
}

// Mesma conta já na fila ou numa partida em andamento (outra aba/aparelho)?
function isUserBusy(userId){
  var busy = false;
  [2, 4].forEach(function(size){
    mmQueues[size].forEach(function(t){ if(t.userId === userId) busy = true; });
  });
  if(busy) return true;
  rooms.forEach(function(room){
    if(room.state === 'ended') return;
    room.sockets.forEach(function(entity){ if(entity.userId === userId) busy = true; });
  });
  return busy;
}

function startMatchedRoom(size, tickets){
  var code = makeRoomCode();
  var room = createRoomObj(code, size);
  room.locked = true;
  rooms.set(code, room);

  tickets.forEach(function(t){
    t.socket.data.mmToken = null;
    var payload = attachPlayer(room, t.socket, t.account);
    t.socket.emit('matchFound', payload);
  });
  broadcastLobby(room);
  console.log('[matchmaking] sala ' + code + ': ' + tickets.length + ' humano(s) + ' + (size - tickets.length) +
    ' bot(s), SR ' + tickets.map(function(t){ return t.sr; }).join('/'));

  // pequena pausa pra todos verem "partida encontrada" antes de começar
  setTimeout(function(){
    if(rooms.get(code) === room && room.state === 'lobby'){ beginRoom(room); }
  }, MM_CFG.startDelayMs);
}

function runMatchmaking(){
  var now = Date.now();
  [2, 4].forEach(function(size){
    // descarta quem desconectou sem avisar
    mmQueues[size] = mmQueues[size].filter(function(t){ return t.socket.connected; });
    var result = findMatches(mmQueues[size], size, now, MM_CFG);
    mmQueues[size] = result.remaining;
    result.matches.forEach(function(m){ startMatchedRoom(size, m.tickets); });
  });
}
setInterval(runMatchmaking, MM_CFG.tickMs);

function destroyRoom(room){
  if(room.tickHandle){ clearInterval(room.tickHandle); room.tickHandle = null; }
  rooms.delete(room.code);
}

function handleLeave(room, socket){
  var wasHost = room.hostSocketId === socket.id;
  var entity = room.sockets.get(socket.id);
  room.sockets.delete(socket.id);
  socket.leave(room.code);

  if(room.state === 'playing'){
    if(entity && entity.alive){ if(killEntity(entity, 'left')) room.deathOrder.push([entity.id]); }
    if(room.sockets.size === 0){ destroyRoom(room); }
    return;
  }

  // ainda na lobby: remove a entidade e escolhe outro host se preciso
  room.entities = room.entities.filter(function(e){ return e !== entity; });
  if(room.sockets.size === 0){ destroyRoom(room); return; }
  if(wasHost){
    var nextId = room.sockets.keys().next().value;
    room.hostSocketId = nextId;
  }
  broadcastLobby(room);
}

/* ==================== INÍCIO E FIM DE PARTIDA ==================== */
function beginRoom(room){
  room.grid = generateMap(room.maxPlayers);
  room.theme = pickTheme();
  room.bombs = []; room.explosions = []; room.powerups = [];
  room.ringsVanished = new Set();
  room.elapsed = 0;

  var spawns = cornerSpawns();
  var idx = 0;
  room.entities = [];
  room.sockets.forEach(function(entity){
    var c = spawns[idx];
    resetEntityForMatch(entity, c.x+0.5, c.y+0.5);
    room.entities.push(entity);
    idx++;
  });
  var botColors = ['#9b5de5', '#ff9f1c', '#2ec4b6'];
  var botsNeeded = room.maxPlayers - room.sockets.size;
  for(var i=0; i<botsNeeded; i++){
    var c2 = spawns[idx];
    var bot = newEntity('bot'+i, c2.x+0.5, c2.y+0.5, botColors[i % botColors.length], true);
    room.entities.push(bot);
    idx++;
  }

  room.state = 'playing';
  io.to(room.code).emit('gameStart', { cols: CFG.cols, rows: CFG.rows, roundTime: CFG.roundTime, theme: room.theme });
  startRoomLoop(room);
}

function checkRoomEnd(room){
  var aliveCount = 0, stillFading = false;
  room.entities.forEach(function(e){
    if(e.alive) aliveCount++;
    else if(e.deathTimer > 0) stillFading = true;
  });

  if(!stillFading && aliveCount <= 1){
    var winner = room.entities.find(function(e){ return e.alive; }) || null;
    endRoom(room, winner, 'elimination');
    return true;
  }
  if(room.elapsed >= CFG.roundTime){
    // só chega aqui com 2+ de pé (o caso de 1 já teria sido pego acima) — empate.
    endRoom(room, null, 'timeup');
    return true;
  }
  return false;
}

var SR_TABLE = {
  2: { placement: {1:15, 2:-15}, tie: {2:0} },
  4: { placement: {1:30, 2:13, 3:-12, 4:-30}, tie: {2:15, 3:-10, 4:-35} }
};
var COINS_TABLE = {
  2: { placement: {1:70, 2:0}, tie: {2:0} },
  4: { placement: {1:70, 2:53, 3:0, 4:0}, tie: {2:53, 3:53, 4:53} }
};

// Transforma a ordem de mortes + quem sobrou vivo numa lista de colocações,
// do 1º lugar pro último. Empates (mortes simultâneas, ou sobreviventes
// quando o tempo acaba) formam um único grupo, todos com a mesma colocação.
function computeStandings(room){
  var groups = room.deathOrder.map(function(g){ return g.slice(); });
  var survivors = room.entities.filter(function(e){ return e.alive; }).map(function(e){ return e.id; });
  if(survivors.length) groups.push(survivors); // sobreviventes = o grupo do topo
  var standings = [];
  var rank = 1;
  for(var i=groups.length-1; i>=0; i--){
    standings.push({ ids: groups[i], rank: rank, size: groups[i].length });
    rank += groups[i].length;
  }
  return standings;
}

// Aplica uma tabela de pontos (SR_TABLE ou COINS_TABLE) às colocações da sala.
// Devolve { idDoJogador: valor }.
function computeStandingValues(room, scoreTable){
  var table = scoreTable[room.maxPlayers];
  var values = {};
  if(!table) return values;
  computeStandings(room).forEach(function(group){
    var value = (group.rank === 1 && group.size >= 2 && table.tie[group.size] !== undefined)
      ? table.tie[group.size]
      : table.placement[group.rank];
    group.ids.forEach(function(id){ values[id] = value; });
  });
  return values;
}

async function applyProfileDelta(userId, column, delta){
  var current = await supabaseAdmin.from('profiles').select(column).eq('id', userId).single();
  if(current.error || !current.data) return null;
  var newValue = (current.data[column] || 0) + delta;
  var patch = {};
  patch[column] = newValue;
  var updated = await supabaseAdmin.from('profiles').update(patch).eq('id', userId);
  if(updated.error) return null;
  return newValue;
}

// Grava o resultado da partida no perfil. Usa a função SQL apply_match_result
// (atômica — ver supabase/apply_match_result.sql). Se ela ainda não existir no
// Supabase ou falhar, cai no método antigo (lê-soma-grava) pra não perder o
// progresso do jogador. Devolve { skill_rating } ou null.
async function applyMatchResult(userId, mode, srDelta, coins, won){
  var res = await supabaseAdmin.rpc('apply_match_result', {
    p_user_id: userId, p_mode: mode, p_sr_delta: srDelta, p_coins: coins, p_won: won
  });
  if(!res.error){
    var row = Array.isArray(res.data) ? res.data[0] : res.data;
    if(row) return row;
  } else {
    console.error('[perfil] apply_match_result falhou (usando método antigo):', res.error.message);
  }

  var srColumn = mode === 2 ? 'skill_rating_2p' : 'skill_rating_4p';
  var newSr = await applyProfileDelta(userId, srColumn, srDelta);
  if(coins > 0) await applyProfileDelta(userId, 'coins', coins);
  if(won) await applyProfileDelta(userId, 'wins', 1);
  await applyProfileDelta(userId, 'matches_played', 1);
  return newSr === null ? null : { skill_rating: newSr };
}

async function endRoom(room, winner, cause){
  room.state = 'ended';
  if(room.tickHandle){ clearInterval(room.tickHandle); room.tickHandle = null; }

  var srDeltas = computeStandingValues(room, SR_TABLE);
  var coinsEarned = computeStandingValues(room, COINS_TABLE);
  var rankById = {}, groupSizeById = {};
  computeStandings(room).forEach(function(group){
    group.ids.forEach(function(id){ rankById[id] = group.rank; groupSizeById[id] = group.size; });
  });

  var standings = [];
  for(var i=0; i<room.entities.length; i++){
    var ent = room.entities[i];
    var entry = {
      id: ent.id, nickname: ent.nickname, isBot: !!ent.isBot,
      rank: rankById[ent.id],
      skillRatingDelta: null, skillRatingNew: null,
      coinsEarned: null
    };
    if(ent.userId && srDeltas[ent.id] !== undefined){
      entry.skillRatingDelta = srDeltas[ent.id];
      entry.coinsEarned = coinsEarned[ent.id] || 0;
      // vitória = 1º lugar sem empate (empate no topo não conta como vitória)
      var won = rankById[ent.id] === 1 && groupSizeById[ent.id] === 1;
      try {
        var updated = await applyMatchResult(ent.userId, room.maxPlayers, entry.skillRatingDelta, entry.coinsEarned, won);
        entry.skillRatingNew = updated ? updated.skill_rating : null;
      } catch(err){
        // um erro no perfil de um jogador não pode impedir o "fim de jogo" de todos
        console.error('[perfil] erro ao gravar resultado de', ent.userId, err);
      }
    }
    standings.push(entry);
  }
  standings.sort(function(a,b){ return a.rank - b.rank; });

  room.sockets.forEach(function(entity, socketId){
    var result = winner === null ? 'draw' : (entity.id === winner.id ? 'win' : 'lose');
    var sock = io.sockets.sockets.get(socketId);
    if(sock) sock.emit('gameOver', { result: result, cause: cause, standings: standings });
  });
}

/* ==================== LOOP DE SIMULAÇÃO ==================== */
function startRoomLoop(room){
  room.lastTickAt = Date.now();
  room.tickHandle = setInterval(function(){
    var now = Date.now();
    var dt = Math.min((now - room.lastTickAt)/1000, 0.1);
    room.lastTickAt = now;
    tickRoom(room, dt);
  }, 1000/CFG.tickRate);
}

function tickRoom(room, dt){
  updateExplosions(room, dt);
  if(room.state !== 'playing') return;

  room.elapsed += dt;

  room.entities.forEach(function(ent){
    if(ent.alive){
      if(ent.isBot) updateBot(room, ent, dt);
      else stepHumanEntity(room, ent, dt);
    } else if(ent.deathTimer > 0){
      ent.deathTimer -= dt;
    }
  });

  updateBombs(room, dt);
  updateStatusEffects(room, dt);
  checkCurseContagion(room);
  updateShrink(room);
  checkPowerupPickup(room);

  broadcastState(room);
  checkRoomEnd(room);
}

function broadcastState(room){
  io.to(room.code).emit('state', {
    elapsed: room.elapsed,
    grid: room.grid,
    entities: room.entities.map(function(e){
      return {
        id:e.id, x:e.x, y:e.y, r:e.r, facing:e.facing, color:e.color,
        alive:e.alive, deathTimer:e.deathTimer, deathReason:e.deathReason,
        maxBombs:e.maxBombs, fireRange:e.fireRange, speedLevel:e.speedLevel,
        curse:e.curse, isBot:!!e.isBot,
        bombPass:e.bombPass, shieldActive:e.shieldActive,
        nickname:e.nickname, characterId:e.characterId
      };
    }),
    bombs: room.bombs.map(function(b){ return {gx:b.gx, gy:b.gy, timer:b.timer, range:b.range}; }),
    explosions: room.explosions.map(function(x){ return {cells:x.cells, t:x.t, duration:x.duration}; }),
    powerups: room.powerups.map(function(p){ return {gx:p.gx, gy:p.gy, type:p.type}; })
  });
}

/* ==================== SOCKET.IO ==================== */
function clampNum(v, lo, hi){
  v = Number(v);
  if(!isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, v));
}

io.on('connection', function(socket){
  socket.on('createRoom', function(opts, cb){
    removeFromQueue(socket);
    var maxPlayers = (opts && opts.maxPlayers===2) ? 2 : 4;
    var code = makeRoomCode();
    var room = createRoomObj(code, maxPlayers);
    rooms.set(code, room);
    joinRoomSocket(room, socket, cb, opts && opts.accessToken);
  });

  socket.on('joinRoom', function(opts, cb){
    removeFromQueue(socket);
    var code = ((opts && opts.code) || '').toUpperCase().trim();
    var room = rooms.get(code);
    if(!room){ cb && cb({ok:false, error:'Sala não encontrada.'}); return; }
    if(room.locked || room.state !== 'lobby'){ cb && cb({ok:false, error:'Essa sala já começou a partida.'}); return; }
    if(room.sockets.size >= room.maxPlayers){ cb && cb({ok:false, error:'Sala cheia.'}); return; }
    joinRoomSocket(room, socket, cb, opts && opts.accessToken);
  });

  socket.on('startGame', function(){
    var room = socketRoom(socket);
    if(!room || room.hostSocketId !== socket.id || room.state !== 'lobby') return;
    beginRoom(room);
  });

  socket.on('input', function(data){
    var room = socketRoom(socket);
    if(!room) return;
    var ent = room.sockets.get(socket.id);
    if(!ent || !ent.input) return;
    ent.input.ix = clampNum(data && data.ix, -1, 1);
    ent.input.iy = clampNum(data && data.iy, -1, 1);
  });

  socket.on('placeBomb', function(){
    var room = socketRoom(socket);
    if(!room) return;
    var ent = room.sockets.get(socket.id);
    if(ent) placeBombFor(room, ent);
  });

  socket.on('sendSticker', function(stickerId){
    var room = socketRoom(socket);
    if(!room) return;
    var ent = room.sockets.get(socket.id);
    if(!ent) return;
    if(typeof stickerId !== 'string') return;
    if(!playerOwnsSticker(ent, stickerId)) return; // não tem esse adesivo
    var now = Date.now();
    if(now - ent.lastStickerAt < STICKER_COOLDOWN_MS) return; // anti-spam
    ent.lastStickerAt = now;
    io.to(room.code).emit('stickerReceived', { from: socket.id, stickerId: stickerId, ts: now });
  });  

  socket.on('findMatch', async function(opts, cb){
    if(socket.data.roomCode){ cb && cb({ ok:false, error:'Você já está em uma sala.' }); return; }
    if(socket.data.mmToken){ cb && cb({ ok:false, error:'Você já está na fila.' }); return; }
    var size = (opts && opts.maxPlayers === 2) ? 2 : 4;
    var token = ++mmTokenSeq;
    socket.data.mmToken = token; // reserva já, pra bloquear duplo clique durante o await

    try {
      var account = await getPlayerAccount(opts && opts.accessToken);
      if(socket.data.mmToken !== token || !socket.connected) return; // cancelou ou caiu enquanto esperava

      if(account && isUserBusy(account.userId)){
        socket.data.mmToken = null;
        cb && cb({ ok:false, error:'Sua conta já está na fila ou em uma partida.' });
        return;
      }

      mmQueues[size].push({
        socket: socket,
        account: account,               // null = convidado
        userId: account ? account.userId : null,
        sr: account && account.skillRating[size] != null ? account.skillRating[size] : 1000,
        joinedAt: Date.now()
      });
      cb && cb({ ok:true });
      runMatchmaking(); // tenta na hora, sem esperar o próximo tick
    } catch(err){
      console.error('[findMatch] erro:', err);
      if(socket.data.mmToken === token) socket.data.mmToken = null;
      cb && cb({ ok:false, error:'Não foi possível entrar na fila. Tente de novo.' });
    }
  });

  socket.on('cancelFindMatch', function(){ removeFromQueue(socket); });

  socket.on('leaveRoom', function(){
    var room = socketRoom(socket);
    if(room) handleLeave(room, socket);
    socket.data.roomCode = null;
  });

  socket.on('disconnect', function(){
    removeFromQueue(socket);
    var room = socketRoom(socket);
    if(room) handleLeave(room, socket);
  });
  
  socket.on('selectCharacter', async function(opts, cb){
    var account = await getPlayerAccount(opts && opts.accessToken);
    if(!account){ cb && cb({ok:false, error:'Entre na sua conta pra trocar de personagem.'}); return; }
    var charId = opts && opts.characterId;
    if(!playerOwnsCharacter({ownedCharacters: account.ownedCharacters}, charId)){
      cb && cb({ok:false, error:'Você não possui esse personagem.'}); return;
    }
    var updated = await supabaseAdmin.from('profiles').update({selected_character: charId}).eq('id', account.userId);
    if(updated.error){ cb && cb({ok:false, error:'Não foi possível salvar.'}); return; }
    cb && cb({ok:true, characterId: charId});
  });  
});

httpServer.listen(PORT, function(){
  console.log('Bomb Arena online rodando na porta ' + PORT);
});

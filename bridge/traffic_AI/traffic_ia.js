/* FlyFranceVFR — module Trafic IA
 * Extrait de la version du 07/11/2026.
 * Dépendances globales fournies par l'application : wsClient, wsConnected,
 * selectedAP, _lastSimData, showNotif().
 */
const _aiTrafficObjects = [];
const _aiTrafficRemoving = new Set();
const _aiTrafficFlying = new Set();
const _aiTrafficFlightPending = new Set();
// Suivi cartographique : un seul avion suivi à la fois, tous les avions IA
// créés restent représentés sur la carte, y compris lorsqu'ils sont stationnés.
let _aiTrafficFollowObjectId = null;
let _aiTrafficMapLayer = null;
// Affichage des avions IA sur la carte : état de la case à cocher du panneau
// Traffic IA, conservé d'une session à l'autre.
let _aiTrafficMapVisible = (() => {try{return localStorage.getItem('flyfrancevfr_ai_map_visible')!=='0';}catch(error){return true;}})();
const _aiTrafficMapMarkers = new Map();
let _aiTrafficLastSnapshot = [];
let _aiRadioPhraseData = null;
let _aiRadioPhrasePromise = null;
const _aiRadioSpokenEvents = new Set();
let _aiRadioEventQueue = Promise.resolve();
let _aiAfisPhraseData = null;
let _aiAfisPhrasePromise = null;

async function _aiRadioLoadPhrases(){
  if(_aiRadioPhraseData)return _aiRadioPhraseData;
  if(!_aiRadioPhrasePromise){
    _aiRadioPhrasePromise=fetch('radio/phrases_aa_avec_mission.json',{cache:'no-store'})
      .then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();})
      .then(data=>{_aiRadioPhraseData=data;return data;})
      .catch(error=>{_aiRadioPhrasePromise=null;console.warn('[Traffic IA Radio] Phrases A/A indisponibles',error);throw error;});
  }
  return _aiRadioPhrasePromise;
}

function _aiRadioTemplate(text,ctx){
  return String(text||'').replace(/\{([a-zA-Z0-9_]+)\}/g,(m,key)=>ctx[key]===undefined||ctx[key]===null?'':String(ctx[key]))
    .replace(/\s{2,}/g,' ').replace(/\s+([,.])/g,'$1').trim();
}

// Piste proposée au lancement : parmi les extrémités de la piste la plus longue, celle qui
// fait face au vent (≥ 3 kt). Le Bridge la corrige ensuite d'après le point d'attente réellement visé.
function _aiTrafficPickRunway(runways){
  const valid=(Array.isArray(runways)?runways:[]).filter(r=>Number(r.trueHeading)>=0&&Number(r.trueHeading)<=360);
  if(!valid.length)return null;
  const len=r=>Number(r.dimension&&r.dimension.length&&r.dimension.length.value)||0;
  const longest=Math.max(...valid.map(len));
  const candidates=valid.filter(r=>len(r)>=longest*0.99);
  const sim=(typeof _lastSimData!=='undefined'&&_lastSimData)||{};
  const windSpeed=Number(sim.wind_speed),windDir=Number(sim.wind_direction);
  if(candidates.length>1&&Number.isFinite(windSpeed)&&Number.isFinite(windDir)&&windSpeed>=3){
    const off=r=>Math.abs((((Number(r.trueHeading)-windDir)%360)+540)%360-180);
    return candidates.slice().sort((a,b)=>off(a)-off(b))[0];
  }
  return candidates[0];
}

// Étiquette « point d'attente + piste » recalculée depuis la piste annoncée.
function _aiTrafficHoldingFull(designator,icao,fallback){
  const qfu=String(designator||'').trim();
  if(!qfu)return fallback;
  const text=typeof radioHoldingPointText==='function'?radioHoldingPointText({designator:qfu},{icao}):'';
  const label=typeof radioHoldingPointLabelFromText==='function'?radioHoldingPointLabelFromText(text):'';
  return label?`${label} piste ${qfu}`:fallback;
}

function handleAIRadioEvent(event){
  // Les jalons reçus du Bridge sont traités strictement dans leur ordre d'arrivée.
  _aiRadioEventQueue=_aiRadioEventQueue.then(()=>_handleAIRadioEventSerial(event)).catch(error=>{console.warn('[Traffic IA Radio] File radio:',error);});
  return _aiRadioEventQueue;
}


// ---------------------------------------------------------------------------
// Radio AFIS des avions IA : mêmes jalons que l'A/A, mais chaque annonce du pilote
// appelle la réponse de l'agent AFIS (voix « afis »). Phrases :
// radio/phrases_afis_avec_mission.json (scénarios departure / arrival / tourDePiste).
// ---------------------------------------------------------------------------
const _AI_AFIS_STEPS_TDP={
  'aa-taxi-tdp':[['tourDePiste','afis-contact-tdp'],['tourDePiste','afis-params-tdp'],['tourDePiste','afis-params-tdp-readback'],['tourDePiste','afis-taxi-tdp']],
  'aa-ready-tdp':[['tourDePiste','afis-ready-tdp']],
  'aa-backtrack-tdp':[['tourDePiste','afis-backtrack-tdp']],
  'aa-lineup-tdp':[['tourDePiste','afis-lineup-tdp']],
  'aa-takeoff-tdp':[['tourDePiste','afis-takeoff-tdp'],['tourDePiste','afis-leave-tdp-readback']],
  'aa-downwind-tdp':[['tourDePiste','afis-downwind-tdp']],
  'aa-base-tdp':[['tourDePiste','afis-base-tdp']],
  'aa-final-tdp-complet':[['tourDePiste','afis-final-tdp-complet'],['tourDePiste','afis-final-tdp-readback']],
  'aa-vacate-tdp':[['tourDePiste','afis-parking-tdp']],
  'aa-leave-tdp':[['tourDePiste','afis-leave-tdp']]
};
// Les avions IA ne s'entendent que si une radio du joueur est réglée sur la fréquence du
// terrain où ils évoluent ET si le joueur se trouve à proximité de ce terrain.
const _AI_RADIO_RANGE_NM=40;
function _aiRadioAudible(icao,mode){
  try{
    if(typeof radioServicesForAirport!=='function'||typeof radioComCandidates!=='function'||typeof radioFreqMatches!=='function')return false;
    const d=(typeof _lastSimData!=='undefined'&&_lastSimData)||{};
    const lat=Number(d.lat),lon=Number(d.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return false;
    const airport=typeof airportByIcao==='function'?airportByIcao(icao):null;
    const aLat=Number(airport&&(airport.lat??airport.latitude)),aLon=Number(airport&&(airport.lon??airport.longitude));
    if(Number.isFinite(aLat)&&Number.isFinite(aLon)){
      const p1=lat*Math.PI/180,p2=aLat*Math.PI/180,dl=(aLon-lon)*Math.PI/180;
      const h=Math.sin((p2-p1)/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
      const nm=2*3440.065*Math.asin(Math.min(1,Math.sqrt(h)));
      if(nm>_AI_RADIO_RANGE_NM)return false;
    }
    const wanted=(radioServicesForAirport(icao)||[]).filter(s=>s&&(mode==='afis'?s.type==='afis':(s.type==='info'||s.type==='auto')));
    if(!wanted.length)return false;
    return radioComCandidates(d).some(com=>wanted.some(s=>radioFreqMatches(com.freq,s.freq)));
  }catch(error){return false;}
}

// 'aa' : auto-information, 'afis' : terrain AFIS sans tour, null : service non géré ici.
function _aiRadioMode(icao){
  if(typeof radioAirportUsesAirToAir==='function'&&radioAirportUsesAirToAir(icao))return 'aa';
  if(typeof radioServicesForAirport==='function'){
    const services=radioServicesForAirport(icao)||[];
    const hasAfis=services.some(s=>s&&s.type==='afis');
    const hasTower=services.some(s=>s&&s.type==='tower');
    if(hasAfis&&!hasTower)return 'afis';
  }
  return null;
}

async function _aiAfisLoadPhrases(){
  if(_aiAfisPhraseData)return _aiAfisPhraseData;
  if(!_aiAfisPhrasePromise){
    _aiAfisPhrasePromise=fetch('radio/phrases_afis_avec_mission.json',{cache:'no-store'})
      .then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();})
      .then(data=>{_aiAfisPhraseData=data;return data;})
      .catch(error=>{_aiAfisPhrasePromise=null;console.warn('[Traffic IA Radio] Phrases AFIS indisponibles',error);throw error;});
  }
  return _aiAfisPhrasePromise;
}

function _aiAfisContext(event,scenarioKey){
  const icao=String(event.airport_icao||'').toUpperCase();
  const airport=(typeof airportByIcao==='function'&&airportByIcao(icao))||{icao,name:event.airport_name||icao};
  const services=typeof radioServicesForAirport==='function'?(radioServicesForAirport(icao)||[]):[];
  const afisService=services.find(s=>s&&s.type==='afis')||null;
  const station=typeof radioStationName==='function'?radioStationName(airport,afisService):String(event.airport_name||icao);
  const callsign=String(event.callsign||'F-XXXX');
  const shortCallsign=typeof radioShortCallsign==='function'?radioShortCallsign(callsign):callsign;
  const qfu=String(event.runway_designator||'piste en service');
  const piste=event.runway_designator?`piste ${qfu}`:'piste en service';
  const holdingFull=String(event.holding_full||_aiTrafficHoldingFull(event.runway_designator,icao,piste));
  const direction=String(event.circuit_direction||'left').toLowerCase();
  const flightData=(typeof _lastSimData!=='undefined'&&_lastSimData)||{};
  // Nombre de personnes à bord stable pour un pilote donné (1 ou 2).
  const seed=String(event.pilot_id||callsign);
  let hash=0;for(let i=0;i<seed.length;i++)hash=((hash*31)+seed.charCodeAt(i))>>>0;
  const persons=1+(hash%2);
  let departurePoint=null;
  if(typeof radioDepartureReportingPoint==='function'){
    try{departurePoint=radioDepartureReportingPoint(airport);}catch(e){departurePoint=null;}
  }
  return {
    station,cs:callsign,shortCs:shortCallsign,
    acType:`un ${String(event.aircraft_model||'avion')}`,
    pob:`${persons} personne${persons>1?'s':''} à bord`,
    destination:'pour des tours de piste',
    piste,qfu,holdingFull,
    qnh:typeof radioQnhText==='function'?radioQnhText(flightData):'',
    wind:typeof radioWindBriefText==='function'?radioWindBriefText():'',
    circuitSide:direction==='right'?' main droite':' main gauche',
    // Pas de consigne « direct point » en tours de piste : le pilote reste en circuit.
    departureInstruction:'',
    departurePointSuffix:departurePoint&&departurePoint.radioName?`, point ${departurePoint.radioName}`:'',
    farewell:scenarioKey==='departure'?"à tout à l'heure":'au revoir',
    inboundOrigin:'en vol retour',
    inboundPosition:'à quelques milles du terrain',
    reportPointCall:'verticale terrain',
    reportInstruction:'Rappelez verticale terrain.',
    reportReadback:'Je rappelle verticale terrain',
    altitudeAnnounce:''
  };
}

// Délai de sécurité : si la synthèse vocale ne rappelle jamais, on libère la file des
// événements radio, sinon tous les avions suivants restent muets.
function _aiSpeakWithTimeout(start,timeoutMs){
  return new Promise(resolve=>{
    let done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>finish(false),timeoutMs);
    try{start(value=>finish(value!==false),()=>finish(false));}catch(error){finish(false);}
  });
}

function _aiAfisSpeak(text,role,event){
  return _aiSpeakWithTimeout((done,fail)=>{
    if(role==='afis'){
      if(typeof radioSpeakWhenIdle!=='function'){fail();return;}
      const queued=radioSpeakWhenIdle(text,'afis',45000,done,600,{hideFromRadioTab:true});
      if(!queued)fail();
    }else{
      if(typeof radioSpeakAIPilot!=='function'){fail();return;}
      const accepted=radioSpeakAIPilot(text,event,done);
      if(!accepted)fail();
    }
  },60000);
}

async function _handleAIAfisEvent(event){
  const objectId=Number(event.object_id)||0;
  const eventId=String(event.event_id||'');
  if(!eventId)return;
  if(!_aiRadioAudible(event.airport_icao,'afis'))return;  // mauvaise fréquence : on n'entend pas
  const steps=_AI_AFIS_STEPS_TDP[eventId];
  if(!steps)return;
  const eventKey=`${objectId}:${eventId}`;
  if(_aiRadioSpokenEvents.has(eventKey))return;
  _aiRadioSpokenEvents.add(eventKey);
  try{
    const data=await _aiAfisLoadPhrases();
    for(const [scenarioKey,rowId] of steps){
      if(!_aiRadioAudible(event.airport_icao,'afis'))break;  // fréquence changée en cours d'échange
      const rows=data&&data.scenarios&&data.scenarios[scenarioKey];
      const row=Array.isArray(rows)?rows.find(r=>r&&r.id===rowId):null;
      if(!row||!row.text){
        console.warn('[Traffic IA Radio] Phrase AFIS absente',scenarioKey,rowId);
        continue;
      }
      const context=_aiAfisContext(event,scenarioKey);
      const pilotText=_aiRadioTemplate(row.text,context);
      const pilotSpoken=await _aiAfisSpeak(pilotText,'pilot',event);
      if(!pilotSpoken)break;  // radio occupée : on n'enchaîne pas une réponse sans appel
      if(row.response){
        const reply=_aiRadioTemplate(row.response,context);
        await _aiAfisSpeak(reply,'afis',event);
      }
      console.info('[Traffic IA Radio] AFIS',event.callsign,rowId,pilotText);
    }
  }catch(error){
    _aiRadioSpokenEvents.delete(eventKey);
    console.warn('Chargement des phrases AFIS impossible : ',error);
  }
}

async function _handleAIRadioEventSerial(event){
  const radioMode=_aiRadioMode(event.airport_icao);
  if(radioMode==='afis')return _handleAIAfisEvent(event);
  if(radioMode!=='aa')return;
  if(event.event_id==='aa-backtrack-tdp'||event.event_id==='aa-lineup-tdp')return;
  if(event.event_id==='aa-inbound-tdp')return;
  // Le tracker émet aussi ce jalon à l'arrêt au parking ; le message est
  // redondant avec « piste dégagée, je roule au parking » déjà annoncé.
  if(event.event_id==='aa-parking-tdp')return;
  if(!_aiRadioAudible(event.airport_icao,'aa'))return;  // mauvaise fréquence : on n'entend pas
  const eventKey=`${Number(event.object_id)||0}:${String(event.event_id||'')}`;
  if(!event.event_id||_aiRadioSpokenEvents.has(eventKey))return;
  _aiRadioSpokenEvents.add(eventKey);
  try{
    const data=await _aiRadioLoadPhrases();
    const airportName=String(event.airport_name||event.airport_icao||'Aérodrome').replace(/^A[eé]rodrome d['’]\s*/i,'').replace(/\s*\([A-Z]{4}\)\s*$/,'');
    const callsign=String(event.callsign||'F-XXXX');
    const shortCallsign=typeof radioShortCallsign==='function'?radioShortCallsign(callsign):callsign;
    const direction=String(event.circuit_direction||'left').toLowerCase();
    const qfu=String(event.runway_designator||'piste en service');
    const holdingLabel=typeof radioHoldingPointLabelFromText==='function'
      ?radioHoldingPointLabelFromText(typeof radioHoldingPointText==='function'?radioHoldingPointText({designator:qfu},{icao:event.airport_icao}):'')
      :'';
    const holdingFull=holdingLabel?`${holdingLabel} piste ${qfu}`:`piste ${qfu}`;
    const context={
      trafficName:airportName,cs:callsign,shortCs:shortCallsign,
      acType:`un ${String(event.aircraft_model||'avion')}`,
      holdingFull:String(event.holding_full||holdingFull),
      qfu,
      circuitSide:direction==='right'?' main droite':' main gauche',
      destination:'',farewell:'au revoir'
    };
    const say=async(text)=>{
      if(typeof radioSpeakAIPilot==='function'){
        await _aiSpeakWithTimeout((done,fail)=>{
          const accepted=radioSpeakAIPilot(text,event,done);
          if(!accepted)fail();
        },60000);
      }else if(typeof radioSpeakSequence==='function'){
        radioSpeakSequence([{text:text,role:'pilot'}]);
      }
    };
    const rows=data&&data.scenarios&&data.scenarios.tourDePiste;
    const phrase=Array.isArray(rows)?rows.find(row=>row&&row.id===event.event_id):null;
    if(!phrase||!phrase.text){
      console.warn('[Traffic IA Radio] Phrase absente pour',event.event_id,'(scénario tourDePiste)');
      // Visible dans le journal radio : sinon l'avion reste muet sans explication.
      return;
    }
    const spoken=_aiRadioTemplate(phrase.text,context);
    await say(spoken);
    console.info('[Traffic IA Radio] Annonce',event.callsign,event.event_id,spoken);
  }catch(error){
    _aiRadioSpokenEvents.delete(eventKey);
    console.warn('Chargement des phrases A/A impossible : ',error);
  }
}

function renderAITrafficList(){
  const list=document.getElementById('ai-traffic-list');
  if(!list)return;
  if(!_aiTrafficObjects.length){list.textContent='Aucun avion IA créé pendant cette session.';return;}
  const orderedObjects=[..._aiTrafficObjects].sort((a,b)=>(Number(a.created_at)||0)-(Number(b.created_at)||0)||(Number(a.object_id)||0)-(Number(b.object_id)||0));
  const launchable=_aiTrafficLaunchableObjects();
  const launchAll=launchable.length>=2?`<button class="btn" type="button" title="Lancer la mission de chaque avion disponible ; ils partent à quelques minutes d'intervalle" onclick="startAllAIAircraftMissions()" style="width:100%;padding:9px 10px;color:#67c58a;border:1px solid currentColor;">✈ Lancer les ${launchable.length} missions</button>`:'';
  list.innerHTML=launchAll+orderedObjects.map(x=>{
    const id=Number(x.object_id);
    const removing=_aiTrafficRemoving.has(id);
    const flying=_aiTrafficFlying.has(id);
    const pending=_aiTrafficFlightPending.has(id);
    const isPatrol=_aiTrafficIsPatrol(x);
    const canPilot=true;
    const mission=_aiTrafficMissionFor(x);
    const missionLabel=_aiTrafficMissionLabel(mission);
    const pilotTitle=isPatrol?'Patrouille en vol : mission non disponible':`Lancer la mission : ${missionLabel}`;
    return `<div class="card" style="cursor:default;display:flex;align-items:center;gap:10px;">
      <div style="flex:1;min-width:0;"><div class="ct">${String(x.model||'Avion IA')} · ${String(x.tail_number||'Sans immatriculation')}</div><div class="cs">${String(x.airport_icao||'')}</div><div class="cs" style="color:#67c8ff;">${_aiTrafficEscapeHtml(missionLabel)}</div></div>
      <button class="btn" type="button" title="${pilotTitle}" aria-label="Piloter cet avion IA" onclick="startAIAircraftMission(${id})" ${removing||flying||pending||isPatrol?'disabled':''} style="min-width:40px;padding:8px 10px;color:#67c58a;border:1px solid currentColor;${isPatrol?'opacity:0.4;':''}">${pending?'…':(isPatrol?'🛩':flying?'✈…':'✈')}</button>
      ${`<button class="btn" type="button" role="tab" aria-selected="${_aiTrafficFollowObjectId===id?'true':'false'}" title="Afficher et suivre cet avion sur la carte" onclick="toggleAIAircraftMapFollow(${id})" style="padding:7px 9px;color:${_aiTrafficFollowObjectId===id?'#67c8ff':'var(--text)'};border:1px solid ${_aiTrafficFollowObjectId===id?'#67c8ff':'var(--border)'};">${_aiTrafficFollowObjectId===id?'✕ Arrêter suivi':'🗺 Carte'}</button>`}
      <button class="btn" type="button" title="Supprimer cet avion IA" aria-label="Supprimer ${String(x.tail_number||'avion IA')}" onclick="removeAIAircraft(${id})" ${removing||flying?'disabled':''} style="min-width:40px;padding:8px 10px;color:#e05252;border:1px solid currentColor;">${removing?'…':'🗑'}</button>
    </div>`;
  }).join('');
}
function _aiTrafficEscapeHtml(value){
  return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function _aiTrafficEnsureMapLayer(){
  if(typeof map==='undefined'||!map||typeof L==='undefined')return false;
  if(!_aiTrafficMapLayer)_aiTrafficMapLayer=L.layerGroup().addTo(map);
  return true;
}
function _aiTrafficMarkerIcon(heading,selected){
  const color=selected?'#36b8ff':'#ffb84d';
  const svg=`<div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;transform:rotate(${Number(heading)||0}deg);filter:drop-shadow(0 1px 4px #000);"><svg viewBox="0 0 100 100" width="34" height="34" aria-hidden="true"><path d="M50 5 L58 40 L91 60 L88 69 L57 59 L55 86 L69 94 L69 99 L50 93 L31 99 L31 94 L45 86 L43 59 L12 69 L9 60 L42 40 Z" fill="${color}" stroke="#17212b" stroke-width="3"/></svg></div>`;
  return L.divIcon({className:'ai-traffic-map-icon',html:svg,iconSize:[38,38],iconAnchor:[19,19]});
}
function updateAITrafficOnMap(data){
  const traffic=Array.isArray(data&&data.traffic)?data.traffic:[];
  if(traffic.length)_aiTrafficLastSnapshot=traffic;
  if(!_aiTrafficMapVisible)return; // couche masquée : on conserve seulement le cliché
  if(!_aiTrafficObjects.length||!_aiTrafficEnsureMapLayer())return;
  const byId=new Map(_aiTrafficLastSnapshot.map(item=>[Number(item.id),item]));
  const ownLat=Number(data&&data.lat),ownLon=Number(data&&data.lon);
  const distanceKm=(a,b,c,d)=>{
    const rad=x=>x*Math.PI/180, dLat=rad(c-a),dLon=rad(d-b);
    const h=Math.sin(dLat/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dLon/2)**2;
    return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
  };
  _aiTrafficObjects.forEach(aircraft=>{
    const id=Number(aircraft.object_id),position=byId.get(id);
    if(!Number.isFinite(id)||!position)return; // conserver le dernier point connu si un échantillon manque
    const lat=Number(position.lat),lon=Number(position.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return;
    const selected=_aiTrafficFollowObjectId===id;
    // Affichage local 15 km, disparition avec marge à 100 km ; un avion suivi
    // reste visible même s'il s'éloigne au-delà de cette enveloppe.
    if(!selected&&Number.isFinite(ownLat)&&Number.isFinite(ownLon)&&distanceKm(ownLat,ownLon,lat,lon)>100){
      const outsideMarker=_aiTrafficMapMarkers.get(id);
      if(outsideMarker&&map.hasLayer&&!map.hasLayer(outsideMarker))return;
      if(outsideMarker&&map.hasLayer&&map.hasLayer(outsideMarker))_aiTrafficMapLayer.removeLayer(outsideMarker);
      return;
    }
    const icon=_aiTrafficMarkerIcon(position.heading,selected);
    const marker=_aiTrafficMapMarkers.get(id);
    const label=`${aircraft.model||'Avion IA'} · ${aircraft.tail_number||'Sans immatriculation'}`;
    const popup=`<b>${_aiTrafficEscapeHtml(label)}</b><br>${position.on_ground?'Au sol':'En vol'} · ${Math.round(Number(position.ground_speed)||0)} kt${Number.isFinite(Number(position.altitude))?` · ${Math.round(Number(position.altitude))} ft`:''}`;
    const tail=String(aircraft.tail_number||'').trim();
    if(marker){
      marker.setLatLng([lat,lon]);marker.setIcon(icon);
      if(tail){
        if(marker.getTooltip&&marker.getTooltip())marker.setTooltipContent(_aiTrafficEscapeHtml(tail));
        else marker.bindTooltip(_aiTrafficEscapeHtml(tail),{permanent:true,direction:'top',offset:[0,-12],className:'ai-tail-label'});
      }
      if(marker.getPopup())marker.setPopupContent(popup);
      if(map.hasLayer&&!map.hasLayer(marker))marker.addTo(_aiTrafficMapLayer);
    }
    else{
      const created=L.marker([lat,lon],{icon,zIndexOffset:selected?1600:1200,interactive:true}).bindPopup(popup).addTo(_aiTrafficMapLayer);
      if(tail)created.bindTooltip(_aiTrafficEscapeHtml(tail),{permanent:true,direction:'top',offset:[0,-12],className:'ai-tail-label'});
      _aiTrafficMapMarkers.set(id,created);
    }
  });
  if(_aiTrafficMapVisible&&_aiTrafficFollowObjectId!==null){
    const marker=_aiTrafficMapMarkers.get(Number(_aiTrafficFollowObjectId));
    if(marker&&map&&typeof map.panTo==='function')map.panTo(marker.getLatLng(),{animate:false});
  }
}
// Cache ou montre la couche Leaflet des avions IA. Les marqueurs restent
// conservés : au réaffichage, ils reprennent leur dernière position connue.
function setAITrafficMapVisible(visible){
  _aiTrafficMapVisible=!!visible;
  try{localStorage.setItem('flyfrancevfr_ai_map_visible',_aiTrafficMapVisible?'1':'0');}catch(error){}
  if(typeof map==='undefined'||!map)return;
  if(!_aiTrafficMapVisible){
    if(_aiTrafficMapLayer&&map.hasLayer(_aiTrafficMapLayer))map.removeLayer(_aiTrafficMapLayer);
    return;
  }
  _aiTrafficEnsureMapLayer();
  // _aiTrafficMapLayer existe toujours après un masquage : il faut le
  // rattacher explicitement à la carte, sinon les marqueurs sont ajoutés
  // à un groupe hors carte et ne réapparaissent jamais.
  if(_aiTrafficMapLayer&&!map.hasLayer(_aiTrafficMapLayer))map.addLayer(_aiTrafficMapLayer);
  updateAITrafficOnMap({traffic:_aiTrafficLastSnapshot});
}
function onAITrafficMapVisibleToggle(checked){setAITrafficMapVisible(checked);}
// Restaure l'état de la case à cocher au chargement de l'interface.
(function _aiTrafficRestoreMapVisible(){
  const chk=document.getElementById('ai-map-visible-chk');
  if(chk)chk.checked=_aiTrafficMapVisible;
  if(!_aiTrafficMapVisible)setAITrafficMapVisible(false);
})();
function toggleAIAircraftMapFollow(objectId){
  const id=Number(objectId);
  if(!Number.isInteger(id)||id<=0)return false;
  if(_aiTrafficFollowObjectId===id){
    _aiTrafficFollowObjectId=null;
    renderAITrafficList();
    updateAITrafficOnMap({traffic:_aiTrafficLastSnapshot});
    showNotif('Suivi de l’avion IA arrêté.');
    return true;
  }
  _aiTrafficFollowObjectId=id; // un seul avion suivi ; un nouveau choix remplace l'ancien
  updateAITrafficOnMap({traffic:_aiTrafficLastSnapshot});
  renderAITrafficList();
  const marker=_aiTrafficMapMarkers.get(id);
  if(marker&&typeof map!=='undefined'&&map){
    map.setView(marker.getLatLng(),Math.max(Number(map.getZoom())||0,12),{animate:true});
    marker.openPopup();
    showNotif('Avion IA affiché sur la carte : suivi actif.');
  }else showNotif('Position de cet avion pas encore reçue de MSFS ; affichage dès la prochaine télémétrie.');
  return true;
}
function removeAIAircraftMapMarker(objectId){
  const id=Number(objectId),marker=_aiTrafficMapMarkers.get(id);
  if(marker&&_aiTrafficMapLayer)_aiTrafficMapLayer.removeLayer(marker);
  _aiTrafficMapMarkers.delete(id);
  if(_aiTrafficFollowObjectId===id)_aiTrafficFollowObjectId=null;
  _aiTrafficLastSnapshot=_aiTrafficLastSnapshot.filter(item=>Number(item.id)!==id);
}

function removeAIAircraft(objectId){
  const id=Number(objectId);
  if(!Number.isInteger(id)||id<=0)return;
  if(!wsClient||wsClient.readyState!==1){showNotif('Bridge FlyFranceVFR non connecté');return;}
  if(!_aiTrafficObjects.some(x=>Number(x.object_id)===id))return;
  _aiTrafficRemoving.add(id);
  renderAITrafficList();
  wsClient.send(JSON.stringify({type:'aiRemoveObject',object_id:id}));
}
function updateAITrafficPanel(){
  const dr=document.getElementById('ai-create-dr400');
  const c172=document.getElementById('ai-create-c172');
  const da40=document.getElementById('ai-create-da40ng');
  const patrol1=document.getElementById('ai-patrol-dr400');
  const patrol2=document.getElementById('ai-patrol-c172');
  const patrol3=document.getElementById('ai-patrol-da40ng');
  const airport=selectedAP&&selectedAP.icao?String(selectedAP.icao).toUpperCase():'';
  const onGround=!!(_lastSimData&&_lastSimData.on_ground);
  const ready=!!(wsConnected&&airport&&onGround);
  const readyPatrol=!!(wsConnected&&airport);
  if(dr)dr.disabled=!ready;
  if(c172)c172.disabled=!ready;
  if(da40)da40.disabled=!ready;
  if(patrol1)patrol1.disabled=!readyPatrol;
  if(patrol2)patrol2.disabled=!readyPatrol;
  if(patrol3)patrol3.disabled=!readyPatrol;
}
function createAIParkedAircraft(model){
  if(!wsClient||wsClient.readyState!==1){showNotif('Bridge FlyFranceVFR non connecté');return;}
  if(!selectedAP||!selectedAP.icao){showNotif('Aucun aérodrome actif détecté par MSFS');return;}
  if(!_lastSimData||!_lastSimData.on_ground){showNotif('La création au parking nécessite que ton avion soit au sol');return;}
  const airport=String(selectedAP.icao).toUpperCase();
  wsClient.send(JSON.stringify({type:'aiCreateParked',model,airport_icao:airport}));
}
function createAIPatrol(model,radiusNm,altitudeFt){
  if(!wsClient||wsClient.readyState!==1){showNotif('Bridge FlyFranceVFR non connecté');return;}
  if(!selectedAP||!selectedAP.icao){showNotif('Aucun aérodrome actif détecté par MSFS');return;}
  if(!Number.isFinite(Number(selectedAP.lat))||!Number.isFinite(Number(selectedAP.lon))){showNotif('Position de l\'aérodrome inconnue');return;}
  const airport={icao:String(selectedAP.icao).toUpperCase(),name:String(selectedAP.name||selectedAP.icao),
        latitude:Number(selectedAP.lat),longitude:Number(selectedAP.lon),altitude_ft:Number(_lastSimData&&_lastSimData.altitude)||0};
  const payload={type:'aiCreatePatrol',model,airport};
  if(Number.isFinite(Number(radiusNm))&&Number(radiusNm)>0)payload.radius_nm=Number(radiusNm);
  if(Number.isFinite(Number(altitudeFt))&&Number(altitudeFt)>0)payload.altitude_ft=Number(altitudeFt);
  wsClient.send(JSON.stringify(payload));
}
function handleAITrafficMessage(d){
  if(d.type==='aiRadioEvent'){handleAIRadioEvent(d);return;}
  if((d.type==='aiTrafficResult'&&d.event==='flight')||d.type==='aiTrafficFlightAccepted'||d.type==='aiTrafficFlightPlan'){
    const flightId=Number(d.object_id);
    if(Number.isInteger(flightId)&&flightId>0){
      _aiTrafficFlightPending.delete(flightId);
      if(d.ok&&['local_circuit','taxi_out','outbound','return'].includes(d.phase))_aiTrafficFlying.add(flightId);
      if(!d.ok||d.phase==='completed')_aiTrafficFlying.delete(flightId);
      renderAITrafficList();
    }
    if(!d.ok)showNotif(`Vol IA : ${d.message}`);
    else if(d.phase==='return')showNotif('Avion IA : retour vers son aérodrome de départ.');
    else if(d.phase==='completed')showNotif('Avion IA revenu et stationné au parking.');
    return;
  }
  if(d.type==='aiTrafficAccepted'){
    if(!d.ok)showNotif(`Trafic IA : ${d.message}`);
    return;
  }
  if(d.type==='aiTrafficQueued'){
    return;
  }
  if(d.type==='aiTrafficResult'&&d.event!=='flight'){
    if(d.ok){
      if(d.phase==='patrol'){
        // Confirmation que le circuit de patrouille a été accepté par MSFS.
        showNotif(`Patrouille IA active (${d.model||'avion'} en vol).`);
        return;
      }
      if(!_aiTrafficObjects.some(x=>Number(x.object_id)===Number(d.object_id)))_aiTrafficObjects.push(d);
      renderAITrafficList();
      if(d.phase==='created-patrol')showNotif(`${d.model} en patrouille au-dessus de ${d.airport_icao} — circuit en cours d'envoi.`);
      else showNotif(`${d.model} créé au parking de ${d.airport_icao}`);
    }else showNotif(`Création IA impossible : ${d.message}`);
    return;
  }
  if(d.type==='aiTrafficRemoveAccepted'){
    if(!d.ok){
      _aiTrafficRemoving.delete(Number(d.object_id));
      renderAITrafficList();
      showNotif(`Suppression IA impossible : ${d.message}`);
    }
    return;
  }
  if(d.type==='aiTrafficRemoved'){
    const id=Number(d.object_id);
    _aiTrafficRemoving.delete(id);
    if(d.ok){
      removeAIAircraftMapMarker(id);
      const index=_aiTrafficObjects.findIndex(x=>Number(x.object_id)===id);
      if(index>=0)_aiTrafficObjects.splice(index,1);
      showNotif('Avion IA supprimé.');
    }else showNotif(`Suppression IA impossible : ${d.message}`);
    renderAITrafficList();
  }
}

// Avions IA pouvant partir : parqués sur l'aérodrome actif, ni en vol, ni en cours de lancement ou de suppression.
function _aiTrafficLaunchableObjects(){
  const icao=selectedAP&&selectedAP.icao?String(selectedAP.icao).toUpperCase():'';
  if(!icao)return [];
  return [..._aiTrafficObjects]
    .filter(x=>String(x.airport_icao||'').toUpperCase()===icao)
    .filter(x=>!(x.patrol||x.phase==='created-patrol'||x.phase==='patrol')) // patrouille en vol : pas de mission au sol
    .filter(x=>{const id=Number(x.object_id);return !_aiTrafficRemoving.has(id)&&!_aiTrafficFlying.has(id)&&!_aiTrafficFlightPending.has(id);})
    .sort((a,b)=>(Number(a.created_at)||0)-(Number(b.created_at)||0)||(Number(a.object_id)||0)-(Number(b.object_id)||0));
}

// Missions : un avion = une mission, attribuée selon l'ordre de création sur l'aérodrome
// (1er : tours de piste, 2e : vol vers l'aérodrome le plus proche, puis on recommence).
const AI_TRAFFIC_MISSIONS=['circuit','nearest'];
function _aiTrafficIsPatrol(aircraft){
  return !!(aircraft&&(aircraft.patrol||aircraft.phase==='created-patrol'||aircraft.phase==='patrol'));
}
function _aiTrafficMissionFor(aircraft){
  if(_aiTrafficIsPatrol(aircraft))return 'patrol';
  const icao=String(aircraft&&aircraft.airport_icao||'').toUpperCase();
  const sameAirport=[..._aiTrafficObjects]
    .filter(a=>String(a.airport_icao||'').toUpperCase()===icao)
    .sort((a,b)=>(Number(a.created_at)||0)-(Number(b.created_at)||0)||(Number(a.object_id)||0)-(Number(b.object_id)||0));
  const rank=Math.max(0,sameAirport.findIndex(a=>Number(a.object_id)===Number(aircraft.object_id)));
  return AI_TRAFFIC_MISSIONS[rank%AI_TRAFFIC_MISSIONS.length];
}
function _aiTrafficMissionLabel(mission){
  if(mission==='patrol')return 'Patrouille en vol : circuit autour de la zone';
  if(mission==='nearest'){
    const near=(typeof selectedAP!=='undefined'&&selectedAP&&selectedAP.icao)?_aiTrafficNearestAerodrome(selectedAP):null;
    return near?`Mission : vol vers ${near.a.icao} (aérodrome le plus proche)`:'Mission : vol vers l’aérodrome le plus proche';
  }
  return 'Mission : tours de piste';
}
function _aiTrafficDistNm(lat1,lon1,lat2,lon2){
  const rad=x=>x*Math.PI/180,dLat=rad(lat2-lat1),dLon=rad(lon2-lon1);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 3440.065*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
// Aérodrome le plus proche (autre que le départ) disposant d'au moins une piste dans les données.
function _aiTrafficNearestAerodrome(ap){
  const list=(typeof AIRPORTS!=='undefined'&&Array.isArray(AIRPORTS))?AIRPORTS:[];
  const here=String(ap.icao||'').toUpperCase();
  let best=null;
  list.forEach(a=>{
    const icao=String(a.icao||'').toUpperCase();
    if(icao.length!==4||icao===here)return;
    if(!Array.isArray(a.runways)||!a.runways.length)return;
    const lat=Number(a.lat),lon=Number(a.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
    const d=_aiTrafficDistNm(Number(ap.lat),Number(ap.lon),lat,lon);
    if(d<2)return;
    if(!best||d<best.d)best={a,d};
  });
  return best;
}

// Lance la mission attribuée à cet avion.
function startAIAircraftMission(objectId){
  const id=Number(objectId);
  const aircraft=_aiTrafficObjects.find(x=>Number(x.object_id)===id);
  if(!aircraft){showNotif('Avion IA invalide');return false;}
  if(_aiTrafficIsPatrol(aircraft)){showNotif('Cet avion est en patrouille en vol : pas de mission au sol. Supprime-le et recrée-le au parking si besoin.');return false;}
  const mission=_aiTrafficMissionFor(aircraft);
  if(mission==='nearest')return startAIAircraftNearestAerodrome(id);
  return startAIAircraftLocalCircuit(id);
}

// Vol vers l'aérodrome le plus proche (aller, atterrissage, puis retour géré par le Bridge).
function startAIAircraftNearestAerodrome(objectId){
  const id=Number(objectId);
  if(!Number.isInteger(id)||id<=0){showNotif('Avion IA invalide');return false;}
  if(!wsClient||wsClient.readyState!==1){showNotif('Bridge FlyFranceVFR non connecté');return false;}
  if(!selectedAP||!selectedAP.icao||!Number.isFinite(Number(selectedAP.lat))||!Number.isFinite(Number(selectedAP.lon))){showNotif('Aérodrome actif MSFS indisponible');return false;}
  if(!_lastSimData||!_lastSimData.on_ground){showNotif('Le départ nécessite que ton avion soit au sol sur cet aérodrome');return false;}
  const near=_aiTrafficNearestAerodrome(selectedAP);
  if(!near){showNotif('Aucun autre aérodrome avec piste trouvé à proximité');return false;}
  const altitude=Number(_lastSimData.altitude)||0;
  const departure={icao:String(selectedAP.icao).toUpperCase(),name:String(selectedAP.name||selectedAP.icao),latitude:Number(selectedAP.lat),longitude:Number(selectedAP.lon),altitude_ft:altitude};
  const destination={icao:String(near.a.icao).toUpperCase(),name:String(near.a.name||near.a.icao),latitude:Number(near.a.lat),longitude:Number(near.a.lon),altitude_ft:altitude};
  _aiTrafficFlightPending.add(id);
  renderAITrafficList();
  try{
    wsClient.send(JSON.stringify({type:'aiStartRoundTrip',object_id:id,departure,destination}));
  }catch(err){
    _aiTrafficFlightPending.delete(id);
    renderAITrafficList();
    showNotif('Impossible d’envoyer la commande au Bridge');
    return false;
  }
  return true;
}

// Lance la mission de tous les avions disponibles. Le Bridge échelonne les départs de quelques minutes.
function startAllAIAircraftMissions(){
  const targets=_aiTrafficLaunchableObjects();
  if(!targets.length){showNotif('Aucun avion IA disponible sur cet aérodrome');return 0;}
  let started=0;
  targets.forEach(x=>{if(startAIAircraftMission(Number(x.object_id)))started++;});
  return started;
}

// Lance un tour de piste pour un avion sur l'aérodrome où le joueur est actuellement posé.
function startAIAircraftLocalCircuit(objectId){
  const id=Number(objectId);
  if(!Number.isInteger(id)||id<=0){showNotif('Avion IA invalide');return false;}
  if(!wsClient||wsClient.readyState!==1){showNotif('Bridge FlyFranceVFR non connecté');return false;}
  if(!selectedAP||!selectedAP.icao||!Number.isFinite(Number(selectedAP.lat))||!Number.isFinite(Number(selectedAP.lon))){showNotif('Aérodrome actif MSFS indisponible');return false;}
  if(!_lastSimData||!_lastSimData.on_ground){showNotif('Le départ du circuit nécessite que ton avion soit au sol sur cet aérodrome');return false;}
  const runways=Array.isArray(selectedAP.runways)?selectedAP.runways:[];
  const runway=_aiTrafficPickRunway(runways);
  if(!runway){showNotif('Aucune orientation de piste exploitable dans les données de cet aérodrome');return false;}
  const airport={icao:String(selectedAP.icao).toUpperCase(),name:String(selectedAP.name||selectedAP.icao),
        latitude:Number(selectedAP.lat),longitude:Number(selectedAP.lon),altitude_ft:Number(_lastSimData.altitude)||0};
  _aiTrafficFlightPending.add(id);
  renderAITrafficList();
  try{
    const holdingText=typeof radioHoldingPointText==='function'?radioHoldingPointText(runway,selectedAP):'';
    const holdingLabel=typeof radioHoldingPointLabelFromText==='function'?radioHoldingPointLabelFromText(holdingText):'';
    const holdingFull=holdingLabel?`${holdingLabel} piste ${String(runway.designator||'')}`:`piste ${String(runway.designator||'')}`;
    wsClient.send(JSON.stringify({type:'aiStartLocalCircuit',object_id:id,airport,runway_heading:Number(runway.trueHeading),runway_designator:String(runway.designator||''),holding_full:holdingFull,circuit_direction:'left',mission:'circuit'}));
  }catch(err){
    _aiTrafficFlightPending.delete(id);
    renderAITrafficList();
    showNotif('Impossible d’envoyer la commande au Bridge');
    return false;
  }
  return true;
}

// API de pilotage aller-retour. La sélection des aérodromes et son interface
// seront raccordées au panneau Traffic IA lors de l'étape UI.
function startAIAircraftRoundTrip(objectId, departure, destination){
  const id=Number(objectId);
  if(!Number.isInteger(id)||id<=0){showNotif('Avion IA invalide');return false;}
  if(!wsClient||wsClient.readyState!==1){showNotif('Bridge FlyFranceVFR non connecté');return false;}
  if(!departure||!destination){showNotif('Informations des deux aérodromes manquantes');return false;}
  wsClient.send(JSON.stringify({type:'aiStartRoundTrip',object_id:id,departure,destination}));
  return true;
}
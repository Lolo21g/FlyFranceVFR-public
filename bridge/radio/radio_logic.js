// FlyFranceVFR - logique radio externe
// Ce fichier est charge par flyfrancevfr.html. Les phrases ecrites sont dans
// radio/phrases_commun.json + radio/phrases_<service>_avec_mission.json /
// _sans_mission.json, chargés et fusionnés par loadRadioPhrases(). Les
// profils de voix sont dans radio/manifest.json.

let _sivXpdrCheck=null;
let _pendingTransponderReadback=null;
const _groundSquawkAssignments={};
const _towerSquawkAssignments={};
let _restrictedZoneTrackAlert={key:'',time:0,checkAt:0};
let _ctrExitTrackAlert={key:'',time:0,checkAt:0};
let _sivExitTrackAlert={key:'',time:0,checkAt:0};

let _lastRadioReply='';
let _radioReplyServiceKey=null;
// La reconnaissance vocale tourne côté bridge (Vosk), indépendante du
// navigateur/WebView2 — voir startRadioListening()/stopRadioListening()/
// handleRadioTranscriptMessage(). _radioListening reflète simplement si une
// session d'écoute est ouverte côté bridge.
let _radioListening=false;
let _radioTranscriptBuffer='';
let _radioPushToTalk=false;
let _radioMicDeviceLabel='Microphone Windows par défaut';
let _radioMicDeviceId=localStorage.getItem('flyfrancevfr_radio_mic_device_id')||'';

// La fréquence affichée comme reconnue devient l'unique autorisation du micro.
// On mémorise aussi le terrain et le service utilisés pendant l'écoute afin
// qu'aucun recalcul momentané ne puisse bloquer la phrase après l'enregistrement.
let _radioValidatedAirport=null;
let _radioValidatedService=null;
let _radioSessionAirport=null;
let _radioSessionService=null;

const RADIO_PTT_KEY='F9';
let _radioKeyboardPtt=JSON.parse(localStorage.getItem('flyfrancevfr_radio_keyboard_ptt')||'null')||{code:RADIO_PTT_KEY,label:'F9'};
let _radioGamepadPtt=JSON.parse(localStorage.getItem('flyfrancevfr_radio_gamepad_ptt')||'null');
let _radioPttLearnMode=false;
let _radioPttLearnStartedAt=0;
let _radioKeyboardLearnTimer=null;
let _radioGamepadPressed=false;
let _radioGamepadLoopStarted=false;
let _radioGamepadLearnBaseline=new Set();
let _radioGamepadLearnWaitRelease=false;
let _radioGamepadLearnTimeout=null;
let _radioPttLabel=RADIO_PTT_KEY;
let _radioSpokenKeys=new Set();
let _lastRadioMatchedPhase='';
let _lastRadioMatchedRow=null;
try{
  localStorage.removeItem('flyfrancevfr_radio_free_flight_mode');
  localStorage.removeItem('flyfrancevfr_radio_free_destination');
  localStorage.removeItem('fvfr_radioStandalone'); // ancienne clé, remplacée par flyfrancevfr_radio_standalone_mode
}catch(e){}
let _radioAaWasAirborne=false;
let _radioAaLandedAfterFlight=false;
let _radioFreeFlightDepartureFrequencyLeft=false;
let _radioFreeFlightAwayIcao='';
let _radioFreeFlightMaxDistNm=0;
// Équivalent du flag ci-dessus, mais côté mission : évite que
// radioMissionFlightScope() bascule en "arrival" avant que le pilote
// n'ait réellement terminé l'échange "je quitte la fréquence" côté radio.
let _radioMissionDepartureFrequencyLeft=false;
let _radioFreeFlightLastServiceKey='';
let _radioFreeFlightLastServiceKind='';
let _radioFreeFlightLastAirportIcao='';
let _activeAtisBroadcastKey='';
let _atisLoopToken=0;
let _atisLoopTimer=null;
// Mode radio autonome : permet d'utiliser la radio sans mission active
// (utile pour un vol libre). Persisté pour rester actif d'une session à
// l'autre. Ne remplace jamais une mission active : si une mission est en
// cours, c'est toujours elle qui pilote la logique radio.
let radioStandaloneMode=(localStorage.getItem('flyfrancevfr_radio_standalone_mode')==='1');
function radioMissionOrStandaloneActive(){
  return !!activeMission||radioStandaloneMode;
}
function setRadioStandaloneMode(v){
  const next=!!v;
  if(next===radioStandaloneMode)return;
  radioStandaloneMode=next;
  try{localStorage.setItem('flyfrancevfr_radio_standalone_mode',radioStandaloneMode?'1':'0');}catch(e){}
  if(!activeMission&&typeof resetRadioFlightState==='function')resetRadioFlightState();
  if(typeof updateRadioPanel==='function')updateRadioPanel();
}
// Sépare le sens de vol (departure/arrival/local, qui pilote la piste
// verrouillée et l'ordre des phases affichées) du "réservoir" de phrases à
// utiliser. En mode autonome sans mission, on va chercher uniquement les
// phrases taguées flightScope:"libre" dans phrases.json, jamais celles de
// depart/arrivee/tour de piste liees a une mission.
function radioActiveContentScope(direction){
  return radioStandaloneMode?'libre':direction;
}
// Pour la génération du contenu des annonces (type d'avion, destination,
// pob, sens de vol...) : le mode autonome, une fois activé, ignore
// totalement une mission en cours. "Pas de mission, pour la radio" est vrai
// soit s'il n'y a réellement aucune mission, soit si le mode autonome est
// actif (même avec une mission en cours).
function radioHasMissionContext(){
  return !!activeMission&&!radioStandaloneMode;
}
let _atisLoopSpeaking=false;
let _atisMissingSince=0;
const _atisMessageStates={};
let _taxiOverspeedSince=0;
let _lastTaxiSpeedWarningAt=0;
const _radioVoiceCache={};
const _radioSpeechQueue=[];
let _radioSpeechActive=false;
let _radioSpeechQueueTimer=null;
let _radioSpeechLastEndedAt=0;
const RADIO_REMINDER_GAP_MS=3000;
let _towerLineupTimer=null;
let _towerLineupPendingKey='';
const _towerLineupIssuedKeys=new Set();
let _towerTakeoffTimer=null;
let _towerTakeoffPendingKey='';
const _towerTakeoffIssuedKeys=new Set();
const _towerTrafficMovement=new Map();
const _radioRunwayLocks=new Map();
let RADIO_CONFIG={version:'1',voiceProfiles:{},audioClips:{}};
let _radioConfigLoaded=false;
let RADIO_PHRASES={version:'1',rows:{},responses:{},phaseMessages:{},weatherMessages:{},trafficMessages:{},transponderMessages:{},fragments:{},atisMessages:{},alerts:{},statusMessages:{}};
let _radioPhrasesLoaded=false;

function radioNormalizeGroupedServices(data){
  const rows={...(data.rows||{})};
  const responses={...(data.responses||{})};
  const services=data.services||{};
  const addResponse=(target,key,response,flightScope)=>{
    const existing=target[key];
    if(existing&&existing.id===response.id&&existing.text===response.text){
      const scopes=[existing.flightScope,flightScope].flat().filter(Boolean);
      target[key]={...existing,flightScope:[...new Set(scopes)]};
      return;
    }
    target[key]={...response,flightScope};
  };
  Object.entries(services).forEach(([role,groups])=>{
    if(!Array.isArray(groups))return;
    const roleRows=[];
    const roleResponses={...(responses[role]||{})};
    groups.forEach(group=>{
      if(!group||typeof group!=='object')return;
      const flightScope=group.flightScope||'';
      (Array.isArray(group.phrases)?group.phrases:[]).forEach(exchange=>{
        if(!exchange||typeof exchange!=='object'||!exchange.demande)return;
        roleRows.push({
          ...exchange.demande,
          flightScope,
          motsValidation:exchange.motsValidation
        });
        const reply=exchange.reponse;
        if(reply&&typeof reply==='object'&&reply.key){
          const {key,...response}=reply;
          addResponse(roleResponses,key,response,flightScope);
        }
      });
      Object.entries(group.reponsesGeneriques||{}).forEach(([key,response])=>{
        addResponse(roleResponses,key,response,flightScope);
      });
    });
    rows[role]=roleRows;
    responses[role]=roleResponses;
  });
  return {rows,responses};
}

// ---------------------------------------------------------------------------
// Format "scénarios" : un fichier = un service + un contexte (ex. AFIS avec
// mission), avec une ligne par étape (demande + réponse + validation) dans
// l'ordre du script. Pour ne pas toucher au reste du moteur pendant la phase
// de test, ce format est converti au chargement vers la structure interne
// historique (groupes flightScope > demande/reponse) que radioNormalizeGroupedServices()
// sait déjà lire. Seul AFIS avec mission l'utilise pour l'instant.
// ---------------------------------------------------------------------------
const RADIO_SCENARIO_FLIGHT_SCOPE={departure:'departure',arrival:'arrival',tourDePiste:'local',libre:'libre',enroute:'enroute'};
// Ids de demande dont le nom historique n'est pas simplement "request-"+id
// (le moteur les reconnaît par leur nom : collationnements AFIS, regex TDP).
const RADIO_SCENARIO_REQUEST_ID_OVERRIDES={
  'afis-params-readback':'request-afis-readback',
  'afis-params-return-readback':'request-afis-readback-return',
  'afis-params-tdp-readback':'request-afis-readback-tdp',
  'afis-leave-tdp-readback':'request-afis-leave-readback-tdp',
  'afis-final-tdp-readback':'request-afis-final-readback-tdp',
  'afis-parking-tdp-readback':'request-afis-parking-readback-tdp',
  'afis-params-readback-libre':'request-afis-readback-libre',
  'afis-params-return-readback-libre':'request-afis-readback-return-libre'
};
// Clés de réponse que le moteur attend quand elles diffèrent de "kind".
const RADIO_SCENARIO_RESPONSE_KEY_OVERRIDES={
  'afis-leave':'sortie',
  'afis-params-return':'integration',
  'afis-final-tdp-complet':'afis_finale_tdp_complet',
  'afis-leave-libre':'sortieLibre',
  'afis-params-return-libre':'integrationLibre',
  'afis-params-return-origine-libre':'integrationLibre',
  'sol-taxi-request-tdp':'sol_taxi_tdp',
  'sol-ready-tdp':'sol_depart_tdp',
  'tour-readback-start-libre':'lineup',
  'tour-ready-lineup-libre':'depart'
};

function radioScenarioRequestId(id){
  return RADIO_SCENARIO_REQUEST_ID_OVERRIDES[id]||`request-${id}`;
}

function radioScenarioResponseKey(row,scenario,service){
  if(RADIO_SCENARIO_RESPONSE_KEY_OVERRIDES[row.id])return RADIO_SCENARIO_RESPONSE_KEY_OVERRIDES[row.id];
  const kind=String(row.kind||'');
  if(scenario==='libre')return `${kind}Libre`;
  if(scenario!=='tourDePiste'||service!=='afis'||kind==='bonjour'||kind==='params')return kind;
  return kind==='depart'?'depart-tdp':`afis_${kind}_tdp`;
}

function radioConvertScenarioFile(part){
  if(!part||typeof part!=='object'||!part.service||!part.scenarios||typeof part.scenarios!=='object')return part;
  const service=String(part.service);
  const groups=[];
  Object.entries(part.scenarios).forEach(([scenario,rows])=>{
    // Scenarios "libre departure"/"libre arrival" : base "libre" + sous-scope
    // de vol, pour distinguer depart et retour meme en mode libre/autonome.
    const scParts=String(scenario).trim().split(/\s+/);
    const baseScenario=scParts[0];
    const subScenario=(scParts[1]==='departure'||scParts[1]==='arrival')?scParts[1]:'';
    const flightScope=RADIO_SCENARIO_FLIGHT_SCOPE[baseScenario];
    if(!flightScope||!Array.isArray(rows))return;
    const phrases=rows.filter(row=>row&&typeof row==='object'&&row.id).map(row=>{
      const demande={
        id:radioScenarioRequestId(row.id),
        phase:row.phase,
        color:row.color,
        text:row.text
      };
      ['when','groundVariant','hidden','surface','requires','mutex','kind'].forEach(k=>{if(row[k]!==undefined)demande[k]=row[k];});
      if(subScenario)demande.scenarioSub=subScenario;
      // Le texte de la réponse reste attaché à sa demande : c'est lui que le
      // curseur (radioScriptRespond) prononce, sans passer par la clé "kind".
      if(row.response)demande.responseText=row.response;
      let reponse=null;
      if(row.response){
        const key=radioScenarioResponseKey(row,baseScenario,service);
        reponse={key,id:`response-${service}-${key.replace(/Libre$/,'-libre')}`,phase:row.phase,color:row.color,text:row.response};
      }
      return {demande,motsValidation:row.motsValidation,reponse};
    });
    groups.push({flightScope,phrases,scenario:baseScenario,subScenario});
  });
  // Fichier d'insertions (Tour sans Sol) : "insertBefore" donne, par scénario, la
  // ligne du déroulé normal avant laquelle les lignes sont glissées.
  if(part.insertBefore&&typeof part.insertBefore==='object'){
    const sansSolInserts=groups
      .filter(g=>part.insertBefore[g.scenario])
      .map(g=>({flightScope:g.flightScope,insertBeforeId:radioScenarioRequestId(part.insertBefore[g.scenario]),phrases:g.phrases}));
    const {service:_s,context:_c,scenarios:_sc,insertBefore:_ib,...rest}=part;
    return {...rest,services:{[service]:{sansSolInserts}}};
  }
  const {service:_s,context:_c,scenarios:_sc,...rest}=part;
  return {...rest,services:{[service]:groups.map(({flightScope,phrases})=>({flightScope,phrases}))}};
}

// Suite d'une information de trafic du SIV : le pilote choisit de répondre
// « trafic en vue » ou « négatif contact », comme en vrai. Les deux lignes
// n'apparaissent qu'après la demande de trafic (condition « sivTrafficGiven »).
function radioInjectSivTrafficFollowUp(data){
  const groups=data&&data.services&&data.services.siv;
  if(!Array.isArray(groups))return;
  groups.forEach(group=>{
    if(!group||!Array.isArray(group.phrases))return;
    const hasId=id=>group.phrases.some(p=>p&&p.demande&&p.demande.id===id);
    const idx=group.phrases.findIndex(p=>p&&p.demande&&p.demande.id==='request-siv-trafic');
    if(idx===-1||hasId('request-siv-trafic-vue'))return;
    const base=group.phrases[idx].demande;
    const libre=group.flightScope==='libre';
    const make=(id,kind,text,words,response)=>({
      demande:{id,phase:base.phase,color:base.color,text,kind,when:'sivTrafficGiven'},
      motsValidation:words,
      reponse:{key:libre?kind+'Libre':kind,id:`response-siv-${kind}${libre?'-libre':''}`,phase:base.phase,color:base.color,text:response}
    });
    group.phrases.splice(idx+1,0,
      make('request-siv-trafic-vue','traficvue','{cs}, trafic en vue.',[['en vue','visuel']],'{shortCs}, reçu.'),
      make('request-siv-trafic-negatif','traficnegatif','{cs}, négatif contact.',[['negatif']],'{shortCs}, reçu, maintenez la vigilance.')
    );
  });
}

async function loadRadioConfig(){
  try{
    const resp=await fetch('radio/manifest.json',{cache:'no-store'});
    if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
    const data=await resp.json();
    if(data&&typeof data==='object'){
      RADIO_CONFIG={
        version:String(data.version||'1'),
        voiceProfiles:data.voiceProfiles||{},
        audioClips:data.audioClips||{}
      };
      _radioConfigLoaded=true;
      console.log('[Radio] Configuration externe chargee',RADIO_CONFIG);
    }
  }catch(e){
    _radioConfigLoaded=false;
    console.warn('[Radio] Configuration externe indisponible, voix internes utilisees',e);
  }
}

async function loadRadioPhrases(){
  try{
    // Les phrases sont désormais éclatées en plusieurs fichiers (un par
    // service, avec/sans mission quand la distinction existe) pour qu'une
    // modification sur une situation précise ne touche jamais aux autres.
    // On les charge tous puis on les fusionne exactement comme s'il
    // s'agissait d'un seul phrases.json.
    const files=[
      'radio/phrases_commun.json',
      'radio/phrases_afis_avec_mission.json',
      'radio/phrases_afis_sans_mission.json',
      'radio/phrases_tour_avec_mission.json',
      'radio/phrases_tour_sans_mission.json',
      'radio/phrases_tour_sans_sol_avec_mission.json',
      'radio/phrases_tour_sans_sol_sans_mission.json',
      'radio/phrases_sol_avec_mission.json',
      'radio/phrases_sol_sans_mission.json',
      'radio/phrases_aa_avec_mission.json',
      'radio/phrases_aa_sans_mission.json',
      'radio/phrases_siv_avec_mission.json',
      'radio/phrases_siv_sans_mission.json'
    ];
    const parts=await Promise.all(files.map(async f=>{
      const resp=await fetch(f,{cache:'no-store'});
      if(!resp.ok)throw new Error(`HTTP ${resp.status} sur ${f}`);
      return resp.json();
    }));
    const data={services:{}};
    // Les fichiers "..._sans_sol_..." n'apportent pas des groupes complets
    // (contact/roulage/prêt au départ/...) mais seulement les quelques
    // phrases "Roulage" propres aux terrains Tour-sans-Sol, à glisser dans
    // le déroulé normal de la Tour, juste avant "prêt au départ". On les
    // met de côté ici pour les insérer une fois tous les groupes assemblés.
    const pendingInserts=[];
    parts.map(radioConvertScenarioFile).forEach(part=>{
      if(!part||typeof part!=='object')return;
      Object.entries(part).forEach(([k,v])=>{
        if(k==='services'&&v&&typeof v==='object'){
          Object.entries(v).forEach(([role,groupsOrInserts])=>{
            if(Array.isArray(groupsOrInserts)){
              data.services[role]=[...(data.services[role]||[]),...groupsOrInserts];
            }else if(groupsOrInserts&&Array.isArray(groupsOrInserts.sansSolInserts)){
              groupsOrInserts.sansSolInserts.forEach(ins=>pendingInserts.push({role,...ins}));
            }
          });
        }else if(!(k in data)){
          data[k]=v;
        }
      });
    });
    pendingInserts.forEach(({role,flightScope,insertBeforeId,replaceFromId,replaceToId,phrases})=>{
      if(!Array.isArray(phrases))return;
      const groups=data.services[role];
      if(!Array.isArray(groups))return;
      const group=groups.find(g=>g&&g.flightScope===flightScope);
      if(!group||!Array.isArray(group.phrases))return;
      if(replaceFromId&&replaceToId){
        // Remplace toute une plage de phrases (ex. "prêt au départ" jusqu'à
        // "je décolle") par un autre déroulé, pour un scénario qui a besoin
        // d'un enchaînement différent de celui du script Tour normal.
        const fromIdx=group.phrases.findIndex(p=>p&&p.demande&&p.demande.id===replaceFromId);
        const toIdx=group.phrases.findIndex(p=>p&&p.demande&&p.demande.id===replaceToId);
        if(fromIdx===-1||toIdx===-1||toIdx<fromIdx)return;
        group.phrases.splice(fromIdx,toIdx-fromIdx+1,...phrases);
        return;
      }
      if(!phrases.length)return;
      const idx=group.phrases.findIndex(p=>p&&p.demande&&p.demande.id===insertBeforeId);
      const at=idx===-1?group.phrases.length:idx;
      group.phrases.splice(at,0,...phrases);
    });
    radioInjectSivTrafficFollowUp(data);
    if(data&&typeof data==='object'){
      const normalized=radioNormalizeGroupedServices(data);
      RADIO_PHRASES={
        version:String(data.version||'1'),
        rows:normalized.rows,
        responses:normalized.responses,
        phaseMessages:data.phaseMessages||{},
        weatherMessages:data.weatherMessages||{},
        trafficMessages:data.trafficMessages||{},
        transponderMessages:data.transponderMessages||{},
        fragments:data.fragments||{},
        atisMessages:data.atisMessages||{},
        alerts:data.alerts||{},
        statusMessages:data.statusMessages||{}
      };
      _radioPhrasesLoaded=true;
      console.log('[Radio] Phrases externes chargees (fichiers separes)',RADIO_PHRASES);
    }
  }catch(e){
    _radioPhrasesLoaded=false;
    console.warn('[Radio] Phrases externes indisponibles, textes internes utilises',e);
  }
}

function radioPhraseRoleAliases(kind){
  const k=String(kind||'').toLowerCase();
  const role=(typeof radioRoleForServiceKind==='function'?radioRoleForServiceKind(k):k)||k;
  const aliases=[role,k];
  if(role==='ground')aliases.push('sol');
  if(role==='tower')aliases.push('tour');
  if(role==='siv')aliases.push('siv');
  if(role==='radio')aliases.push('generic');
  return [...new Set(aliases.filter(Boolean))];
}

function radioPhraseApplyTemplate(template,ctx={}){
  return String(template||'').replace(/\{([a-zA-Z0-9_]+)\}/g,(m,k)=>{
    const v=ctx[k];
    return v===undefined||v===null?m:String(v);
  });
}

function radioPhraseEntryText(entry,ctx={}){
  if(entry===undefined||entry===null)return '';
  if(typeof entry==='string')return entry;
  if(Array.isArray(entry)){
    const scoped=entry.find(item=>radioPhraseEntryMatches(item,ctx));
    return radioPhraseEntryText(scoped||entry[0],ctx);
  }
  if(typeof entry==='object')return entry.text||'';
  return String(entry||'');
}

function radioPhraseEntryMatches(entry,ctx={}){
  if(!entry||typeof entry!=='object')return true;
  const expected=entry.flightScope;
  const actual=ctx.flightScope;
  if(!expected||!actual)return true;
  if(Array.isArray(expected))return expected.map(String).includes(String(actual));
  return String(expected)===String(actual);
}

function radioStructuredResponseValid(entry){
  return !!entry
    && typeof entry==='object'
    && !Array.isArray(entry)
    && !!entry.id
    && !!entry.phase
    && !!entry.color
    && !!entry.text
    && !!entry.flightScope;
}

function radioStructuredRequestValid(entry){
  return !!entry
    && typeof entry==='object'
    && !Array.isArray(entry)
    && !!entry.id
    && !!entry.phase
    && !!entry.color
    && !!entry.text
    && !!entry.flightScope;
}

function radioAlertPhrase(key,ctx={}){
  const alerts=RADIO_PHRASES&&RADIO_PHRASES.alerts;
  const template=alerts&&typeof alerts==='object'
    ?alerts[String(key||'')]
    :'';
  return radioPhraseApplyTemplate(template,ctx);
}

function radioStatusMessage(key,ctx={},fallback=''){
  const messages=RADIO_PHRASES&&RADIO_PHRASES.statusMessages;
  const template=messages&&typeof messages==='object'
    ?messages[String(key||'')]
    :'';
  return radioPhraseApplyTemplate(template||fallback||'',ctx);
}

function radioPhrasePick(section,kind,keys,ctx={}){
  const root=RADIO_PHRASES&&RADIO_PHRASES[section];
  if(!root||!Array.isArray(keys))return '';
  for(const role of radioPhraseRoleAliases(kind)){
    const group=root[role];
    if(!group||typeof group!=='object')continue;
    for(const key of keys){
      const k=String(key||'');
      if(!k)continue;
      if(Object.prototype.hasOwnProperty.call(group,k)){
        const entry=group[k];
        if(section==='responses'){
          if(Array.isArray(entry)){
            const scoped=entry.find(item=>radioStructuredResponseValid(item)&&radioPhraseEntryMatches(item,ctx));
            return scoped?radioPhraseApplyTemplate(scoped.text,ctx):'';
          }
          if(!radioStructuredResponseValid(entry)||!radioPhraseEntryMatches(entry,ctx))continue;
          return radioPhraseApplyTemplate(entry.text,ctx);
        }
        if(!radioPhraseEntryMatches(entry,ctx))continue;
        return radioPhraseApplyTemplate(radioPhraseEntryText(entry,ctx),ctx);
      }
    }
  }
  return '';
}

function radioHoldingPointLabelFromText(text){
  const raw=String(text||'').trim();
  if(!raw)return '';
  const normalized=raw.replace(/[’]/g,"'");
  const match=normalized.match(/point d'attente(?:\s+(.+?))?\s+piste\s+\S+/i);
  if(match)return String(match[1]||'').trim();
  return '';
}

function radioRunwayLockScope(a,d=_lastSimData||{}){
  // Utilise le même sens de vol simplifié (2 états, basé uniquement sur la
  // mission) que les demandes radio, pour que la piste verrouillée corresponde
  // toujours à ce qui est affiché dans les demandes possibles.
  return radioMissionFlightScope(a);
}

function radioRunwayLockKey(a,scope=''){
  const icao=String(a&&a.icao||'').toUpperCase();
  const missionKey=String(activeMission&&activeMission.id||'libre');
  return `${icao}|${missionKey}|${scope||'departure'}`;
}

function radioRunwayByDesignator(a,designator){
  const wanted=String(designator||'').trim().toUpperCase();
  if(!a||!wanted)return null;
  return ((a&&a.runways)||[]).map(r=>{
    const hdg=((Number(r.trueHeading)||0)%360+360)%360;
    return {r,designator:r.designator||formatRunwayHeading(hdg),heading:hdg,diff:0};
  }).find(x=>String(x.designator||'').toUpperCase()===wanted)||null;
}

function lockRadioRunway(a,rwy,scope=''){
  if(!a||!rwy)return rwy||null;
  const designator=String(rwy.designator||'').trim();
  if(!designator)return rwy;
  _radioRunwayLocks.set(radioRunwayLockKey(a,scope||radioRunwayLockScope(a)),designator);
  return rwy;
}

function lockedRadioRunway(a,scope=''){
  if(!a)return null;
  const designator=_radioRunwayLocks.get(radioRunwayLockKey(a,scope||radioRunwayLockScope(a)));
  return radioRunwayByDesignator(a,designator);
}

// Piste verrouillée utilisée par la Tour (clairances alignement/décollage).
// Même verrou que le reste de la radio : null si aucune piste n'est encore
// verrouillée, l'appelant retombe alors sur runwayForWind().
function lockedTowerRunway(a,service){
  return lockedRadioRunway(a,radioRunwayLockScope(a,_lastSimData||{}));
}

function radioRunwayForContext(a,scope=''){
  return lockedRadioRunway(a,scope)||runwayForWind(a,(_lastSimData||{}).wind_direction);
}

// Main du circuit pour les annonces pilote (« vent arrière main gauche »).
// Lit un champ optionnel de la piste dans la base d'aérodromes (circuitSide :
// 'L'/'R'/'left'/'right'/'gauche'/'droite'). Sans donnée, renvoie '' : on
// n'annonce jamais une main qu'on ne connaît pas.
function radioCircuitSideText(rwy){
  const raw=String(rwy&&rwy.r&&(rwy.r.circuitSide||rwy.r.circuit||rwy.r.pattern)||'').trim().toLowerCase();
  if(/^(r|right|d|droite)/.test(raw))return ' main droite';
  if(/^(l|left|g|gauche)/.test(raw))return ' main gauche';
  return '';
}

// Trafic IA vu par l'AFIS : décrit les avions IA de l'application en mouvement
// (roulage, point d'attente, circuit) près de l'aérodrome du pilote.
// Retourne une courte phrase française ('' si aucun avion IA en mouvement).
function radioAiTrafficHintText(rwy){
  const d=_lastSimData||{};
  const a=currentRadioAirport();
  if(!hasValidSimData(d)||!a||!Number.isFinite(Number(a.lat))||!Number.isFinite(Number(a.lon)))return '';
  const lat0=Number(a.lat),lon0=Number(a.lon);
  const aiObjects=(typeof _aiTrafficObjects!=='undefined'&&Array.isArray(_aiTrafficObjects))?_aiTrafficObjects:[];
  if(!aiObjects.length)return '';
  const rwyHdgRaw=rwy?[rwy.trueHeading,rwy.heading,rwy.r&&rwy.r.trueHeading].find(v=>v!=null&&v!==''&&Number.isFinite(Number(v))):null;
  const runwayHeading=rwyHdgRaw!=null?((Number(rwyHdgRaw)%360)+360)%360:null;
  const rad=runwayHeading!=null?runwayHeading*Math.PI/180:null;
  const cosLat=Math.cos(lat0*Math.PI/180);
  const flying=id=>(typeof _aiTrafficFlying!=='undefined'&&_aiTrafficFlying&&_aiTrafficFlying.has)?_aiTrafficFlying.has(Number(id)):false;
  const described=[];
  for(const item of (Array.isArray(d.traffic)?d.traffic:[])){
    const lat=Number(item&&item.lat),lon=Number(item&&item.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))continue;
    const ai=aiObjects.find(x=>Number(x.object_id)===Number(item.id));
    if(!ai)continue;
    const model=String(ai.model||'');
    const typeName=/DR400/i.test(model)?'un DR400':(/DA40/i.test(model)?'un DA40 NG':(/172/i.test(model)?'un Cessna 172':'un avion léger'));
    const tail=String(ai.tail_number||'').trim();
    const speed=Number(item.ground_speed)||0;
    const dx=(lon-lon0)*60*cosLat;
    const dy=(lat-lat0)*60;
    const along=rad!=null?dx*Math.sin(rad)+dy*Math.cos(rad):0;
    const lateral=rad!=null?-dx*Math.cos(rad)+dy*Math.sin(rad):0;
    let state='';
    if(item.on_ground){
      const moving=speed>=2;
      // Aux abords de la piste (~220 m de l'axe, jusqu'à 0,8 nm dans l'axe) :
      // point d'attente, alignement, roulage — un trafic à signaler même au sol.
      const nearRunway=runwayHeading!=null&&Math.abs(lateral)<=0.12&&Math.abs(along)<=0.8;
      // Sur la piste même (~40 m de l'axe) : avion aligné, prêt à décoller.
      const onRunway=runwayHeading!=null&&Math.abs(lateral)<=0.02&&Math.abs(along)<=0.8;
      // À l'arrêt loin de la piste ET sans mission lancée : réellement
      // stationné au parking, pas un trafic à signaler. Tout autre avion au
      // sol (roulage, point d'attente, piste) doit être annoncé : c'est un
      // danger potentiel au décollage même si l'état de mission a été perdu
      // (rechargement de la page, redémarrage du bridge).
      if(!moving&&!nearRunway&&!flying(item.id))continue;
      const axisDiff=runwayHeading!=null
        ?Math.min(Math.abs(((Number(item.heading)-runwayHeading+540)%360)-180),
                  Math.abs(((Number(item.heading)-runwayHeading+720)%360)-180))
        :null;
      if(speed<2){
        if(onRunway){
          state=`sur la piste${rwy&&rwy.designator?' '+rwy.designator:''}, s'apprête à décoller`;
        }else if(nearRunway){
          state=`au point d'attente de la ${rwy.designator}`;
        }else{
          state='en attente';
        }
      }else if(runwayHeading!=null&&speed>=15&&axisDiff<=40){
        // Roulage de décollage dans l'axe (l'ATC MSFS peut utiliser l'un ou
        // l'autre sens de piste : les deux caps sont acceptés).
        state='aligné pour le décollage';
      }else if(onRunway&&speed>=15){
        state='aligné pour le décollage';
      }else{
        state=`au roulage${rwy&&rwy.designator?' piste '+rwy.designator:''}`;
      }
    }else if(runwayHeading!=null){
      const hd=Number(item.heading);
      const hasHd=Number.isFinite(hd);
      const diffSame=hasHd?Math.abs(((hd-runwayHeading+540)%360)-180):999;   // écart avec le cap de piste
      const diffRev=hasHd?180-diffSame:999;                                  // écart avec le cap inverse
      const diffPerp=hasHd?Math.abs(90-diffSame):999;                        // écart avec la perpendiculaire
      const apDist=distNM(lat0,lon0,lat,lon);
      const diffToAp=hasHd?Math.abs(((hd-radioBearingDeg(lat,lon,lat0,lon0)+540)%360)-180):999;
      const rn=rwy&&rwy.designator?rwy.designator:'';
      const fast=speed>=40;
      if(fast&&Math.abs(lateral)<=0.25&&diffSame<=35&&along<0&&along>=-6)state=`en finale${rn?' de la '+rn:''}`;
      else if(fast&&Math.abs(lateral)<=0.25&&diffSame<=35&&along>=0&&along<=2)state='en montée initiale';
      else if(fast&&Math.abs(lateral)>=0.15&&Math.abs(lateral)<=2.5&&diffRev<=25&&Math.abs(along)<=4)state=`en vent arrière${rn?' '+rn:''}`;
      else if(fast&&Math.abs(lateral)<=2.5&&diffPerp<=35&&along>=-3&&along<=1.5)state='en étape de base';
      else if(fast&&apDist<=6&&diffToAp<=45)state='en approche';
      else state='dans la zone';
    }else{
      state='dans la zone';
    }
    if(state)described.push({dist:distNM(lat0,lon0,lat,lon),state,typeName,tail,inAir:!item.on_ground,
                             priority:(state.includes("s'apprête à décoller")||state==='aligné pour le décollage')?1:0});
  }
  if(!described.length)return '';
  // Départ imminent d'abord, avions en vol ensuite, puis le plus proche.
  described.sort((x,y)=>(Number(y.priority)-Number(x.priority))||Number(y.inAir)-Number(x.inAir)||x.dist-y.dist);
  const traffic=described.slice(0,2);
  // Lorsque plusieurs avions sont simplement « dans la zone », annoncer
  // l'état une seule fois après la liste pour éviter une phrase répétitive.
  if(traffic.length>1&&traffic.every(x=>x.state==='dans la zone')){
    return `${traffic.map(x=>`${x.typeName}${x.tail?' '+x.tail:''}`).join(' et ')} dans la zone`;
  }
  return traffic
    .map(x=>`${x.typeName}${x.tail?' '+x.tail:''} ${x.state}`)
    .join(' et ');
}

function radioPhraseContext(station,cs,dest,service,a,holdingPoint,kind=''){
  const d=_lastSimData||{};
  const scope=radioRunwayLockScope(a,d);
  const rwy=radioRunwayForContext(a,scope);
  const windDir=((Math.round(Number(d.wind_direction)||0)%360)+360)%360;
  const windSpeed=Math.round(Number(d.wind_speed)||0);
  const piste=rwy&&rwy.designator?`piste ${rwy.designator}`:'piste en service';
  const holdingText=String(holdingPoint||'')||radioHoldingPointText(rwy,a);
  const holding=radioHoldingPointLabelFromText(holdingText);
  const holdingOnly=holding;
  const holdingFull=holding?`${holding} ${piste}`:piste;
  const pob=radioPersonsOnBoardText();
  const aircraftType=radioAircraftTypeText();
  const acType=`un ${aircraftType}`;
  const kindSvc=radioServiceKind(service);
  const phraseScope=kindSvc==='siv'
    ?radioActiveContentScope('enroute')
    :(radioHasMissionContext()&&activeMission.type==='TourDePiste'?'local':radioActiveContentScope(scope));
  const hasAtis=!!(a&&radioServicesForAirport(a.icao).some(s=>radioServiceKind(s)==='atis'));
  const atisLetter=hasAtis?atisMessageVersion(a,d).letter:'';
  const atisReceived=atisLetter?`, information ${atisLetter} reçue`:'';
  const reportPoint=(kindSvc==='tower'||kindSvc==='afis'||kindSvc==='aa')&&radioIsInboundToAirport(a,d)?radioInboundReportingPoint(a,d):null;
  // AFIS et A/A : le point de sortie tient compte de la position réelle de
  // l'avion une fois en vol (repli sur le calcul depuis l'aérodrome sinon).
  const aircraftPos=(kindSvc==='afis'||kindSvc==='aa')&&hasValidSimData(d)&&!d.on_ground
    ?{lat:Number(d.lat),lon:Number(d.lon)}:null;
  const departurePoint=(kindSvc==='tower'||kindSvc==='afis'||kindSvc==='aa')&&!radioIsInboundToAirport(a,d)
    ?((aircraftPos&&radioDepartureReportingPoint(a,aircraftPos))||radioDepartureReportingPoint(a)):null;
  const ctrAltitude=departurePoint?radioDepartureCtrAltitude(a):'';
  const departureInstruction=[
    departurePoint?`Après décollage, autorisé direct point ${departurePoint.radioName}.`:'',
    ctrAltitude?`maintenez ${ctrAltitude} ou en dessous.`:''
  ].filter(Boolean).join(' ');
  const departureReadback=[
    departurePoint?`Route directe vers point ${departurePoint.radioName}.`:'',
    ctrAltitude?`Maximum ${ctrAltitude}.`:''
  ].filter(Boolean).join(' ');
  const towerService=radioServicesForAirport(a&&a.icao).find(s=>radioServiceKind(s)==='tower');
  const groundService=radioServicesForAirport(a&&a.icao).find(s=>radioServiceKind(s)==='ground');
  const towerFreq=towerService&&towerService.freq?String(towerService.freq):'';
  const groundFreq=groundService&&groundService.freq?String(groundService.freq):'';
  // Sur un terrain sans Sol (ex. LFCL), il n'y a personne à qui transférer
  // après la piste dégagée : la Tour garde l'avion et l'invite simplement à
  // rouler au parking, plutôt que de renvoyer vers une fréquence Sol inexistante.
  const groundHandoffText=groundFreq?`contactez le sol sur ${groundFreq}`:'roulez au parking';
  const groundSquawk=kindSvc==='ground'?assignGroundSquawk(a,service,cs):groundAssignedSquawk(a);
  const towerSquawk=kindSvc==='tower'?assignTowerSquawk(a,service,cs):towerAssignedSquawk(a);
  const sivSquawk=kindSvc==='siv'?radioSivSquawkText(service):'';
  const altitude = Math.round(Number(d.altitude)||0); // Altitude arrondie à l'unité
  // Altitude arrondie à la centaine, prononçable (« 2400 pieds »). Vide au sol ou
  // sans données simulateur, pour que l'annonce disparaisse au lieu d'afficher 0.
  const altitudeRounded=hasValidSimData(d)&&!d.on_ground?Math.max(0,Math.round((Number(d.altitude)||0)/100)*100):null;
  const circuitSide=radioCircuitSideText(rwy);
  // AFIS vivant : les avions IA en mouvement remplacent « pas de trafic connu ».
  const afisTraficHint=(kindSvc==='afis'||kindSvc==='info')?radioAiTrafficHintText(rwy):'';
  return {
    station:station||'',
    cs:cs||'',
    shortCs:radioShortCallsign(cs||''),
    dest:dest||'',
    destination:radioDestinationText(),
    serviceKind:radioServiceKind(service),
    afisTrafic:afisTraficHint?afisTraficHint.charAt(0).toUpperCase()+afisTraficHint.slice(1):'Pas de trafic connu',
    afisTrafic2:afisTraficHint||'pas de trafic connu',
    freq:service&&service.freq?String(service.freq):'',
    airport:a&&(a.name||a.icao)||'',
    icao:a&&a.icao||'',
    runway:rwy&&rwy.designator?rwy.designator:'',
    piste,
    holdingPoint:holding,
    holdingOnly,
    holdingFull,
    qnh:radioQnhText(d),
    windDir:String(windDir).padStart(3,'0'),
    windSpeed:String(windSpeed),
    wind:radioWindBriefText(),
    altitude: String(altitude), 
    altitudeRounded:altitudeRounded===null?'':String(altitudeRounded),
    altitudeAnnounce:altitudeRounded===null?'':`, ${altitudeRounded} pieds`,
    circuitSide,
    pob,
    acType,
    atisLetter,
    atisReceived,
    trafficName:radioTrafficCallName(station),
    groundContactName:`${radioTrafficCallName(station)} Sol`,
    towerFreq,
    groundFreq,
    groundHandoffText,
    groundSquawk,
    towerSquawk,
    sivSquawk,
    inboundOrigin:radioInboundOriginText(),
    inboundOriginAA:radioInboundOriginText(true),
    inboundPosition:radioInboundPositionText(a),
    inboundPositionDir:radioInboundPositionText(a,true),
    sivOrigin:radioSivOriginText(),
    sivDestination:radioSivDestinationText(),
    sivPosition:radioSivPositionText(),
    sivQuitContext:radioSivQuitContextText(service),
    reportPoint:reportPoint?reportPoint.radioName:'verticale',
    reportPointCall:reportPoint?`au point ${reportPoint.radioName}`:'verticale terrain',
    reportInstruction:reportPoint?`Rappelez point ${reportPoint.radioName}.`:'Rappelez verticale terrain.',
    reportReadback:reportPoint?`Je rappelle point ${reportPoint.radioName}`:'Je rappelle verticale terrain',
    departurePoint:departurePoint?departurePoint.radioName:'',
    // Annonces pilote (AFIS / A/A) : vides ou de repli quand aucun point n'existe.
    reportPointAnnounce:reportPoint?`, au point ${reportPoint.radioName}`:'',
    departurePointAnnounce:departurePoint?`, sortie par le point ${departurePoint.radioName}`:'',
    departurePointSuffix:departurePoint?`, point ${departurePoint.radioName}`:'',
    departurePointValidation:departurePoint?departurePoint.radioName:'',
    ctrAltitude,
    departureAltitudeValidation:ctrAltitude?'maximum':'',
    departureInstruction,
    departureReadback,
    farewell:radioFarewellText(),
    paxFarewell:radioHasMissionContext()&&activeMission.type==='Pax'?'au revoir':"à tout à l'heure",
    kind:kind||'',
    flightScope:phraseScope
  };
}

function radioRowsFromExternal(kind,ctx={}){
  const root=RADIO_PHRASES&&RADIO_PHRASES.rows;
  if(!root||typeof root!=='object')return null;
  const a=currentRadioAirport();
  for(const role of radioPhraseRoleAliases(kind)){
    const rows=root[role];
    if(!Array.isArray(rows)||!rows.length)continue;
    return rows
      .filter(row=>radioStructuredRequestValid(row)&&radioExternalRowVisible(row,kind,a))
      .map((row,idx)=>{
        const rowCtx={...ctx,index:String(idx+1)};
        return {
          ...row,
          id:radioPhraseApplyTemplate(row.id,rowCtx),
          text:radioPhraseApplyTemplate(row.text,rowCtx),
          responseText:typeof row.responseText==='string'?radioPhraseApplyTemplate(row.responseText,rowCtx):row.responseText,
          motsValidation:Array.isArray(row.motsValidation)
            ? row.motsValidation.map(group=>(Array.isArray(group)?group:[group])
              .map(term=>radioPhraseApplyTemplate(term,rowCtx)))
            : row.motsValidation
        };
      });
  }
  return null;
}

function radioExternalRowVisible(row,kind,a){
  if(!row||typeof row!=='object'||!row.when)return true;
  const when=String(row.when||'');
  const d=_lastSimData||{};
  const inbound=(kind==='tower'||kind==='afis'||kind==='aa')&&radioIsInboundToAirport(a,d);
  const paxDeparture=radioHasMissionContext()&&activeMission.type==='Pax'&&
    String(a&&a.icao||'').toUpperCase()===String(activeMission.from||'').toUpperCase();
  const isTdp=!!(radioHasMissionContext()&&activeMission.type==='TourDePiste');
  if(when==='inboundTower')return kind==='tower'&&inbound;
  if(when==='departureTower')return kind==='tower'&&!inbound;
  if(when==='paxDepartureTower')return kind==='tower'&&!inbound&&paxDeparture;
  if(when==='localDepartureTower')return kind==='tower'&&!inbound&&!paxDeparture;
  if(when==='inboundAfis')return kind==='afis'&&inbound;
  if(when==='localDepartureAfis')return kind==='afis'&&!inbound;
  if(when==='inboundAA')return kind==='aa'&&inbound;
  if(when==='localDepartureAA')return kind==='aa'&&!inbound;
  if(when==='sivTrafficGiven')return kind==='siv'&&_radioSpokenKeys.has('radio-id|request-siv-trafic');
  if(when==='tourDePiste')return isTdp;
  if(when==='notTourDePiste')return !isTdp;
  if(when==='sivTransitMission'){
    const service=activeRadioServiceForAirport(a&&a.icao)||radioFallbackServiceForAirport(a);
    return kind==='siv'&&radioMissionUsesSivTransit(service);
  }
  return true;
}

function radioSivIdentity(siv){
  const name=normalizePoiText(siv&&(siv.name||siv.info)||'');
  const freq=radioFreqText(siv&&siv.freq||'');
  return name||freq;
}

function radioMissionUsesSivTransit(service){
  if(!radioHasMissionContext()||radioServiceKind(service)!=='siv'||typeof getMissionRoutePoints!=='function')return false;
  const route=getMissionRoutePoints(activeMission);
  if(!Array.isArray(route)||route.length<2)return false;

  const sequence=[];
  for(let i=1;i<route.length;i++){
    const from=route[i-1];
    const to=route[i];
    if(!from||!to)continue;
    const samples=typeof routeSamplePoints==='function'
      ? routeSamplePoints(from,to,60)
      : [from,to];
    samples.forEach(point=>{
      const siv=getSivAt(Number(point.lat),Number(point.lon));
      const identity=radioSivIdentity(siv);
      if(identity&&sequence[sequence.length-1]!==identity)sequence.push(identity);
    });
  }

  const currentIdentity=radioSivIdentity(service&&service.siv);
  const currentIndex=sequence.indexOf(currentIdentity);
  return sequence.length>1&&currentIndex>0;
}

function radioSpeechAvailable(){
  // La reconnaissance vocale tourne côté bridge (Vosk) : le micro est
  // disponible tant que le WebSocket vers le bridge est connecté.
  return typeof wsClient!=='undefined' && !!wsClient && !!wsConnected;
}

function radioSleep(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

function setRadioTranscript(message,fromMicro=false){
  // « Phrase entendue » est réservée exclusivement aux mots réellement
  // reçus par la reconnaissance vocale du microphone.
  if(!fromMicro)return;
  const el=document.getElementById('radio-transcript');
  if(el)el.textContent=String(message||'');
}

let _micPermissionVerified=false;

function updateRadioDefaultMicrophoneLabel(label){
  _radioMicDeviceLabel=String(label||'Microphone Windows par défaut');
}

async function refreshRadioInputDevices(){
  const select=document.getElementById('radio-mic-select');
  if(!select||!navigator.mediaDevices||!navigator.mediaDevices.enumerateDevices)return;
  try{
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='audioinput');
    const physical=devices.filter(device=>device.deviceId&&device.deviceId!=='default'&&device.deviceId!=='communications');
    const defaultDevice=devices.find(device=>device.deviceId==='default');

    select.innerHTML='';
    physical.forEach(device=>{
      const option=document.createElement('option');
      option.value=device.deviceId;
      option.textContent=device.label||`Microphone ${select.options.length+1}`;
      select.appendChild(option);
    });

    if(!physical.length){
      select.innerHTML='<option value="">Aucun microphone détecté</option>';
      return;
    }

    if(!_radioMicDeviceId||!physical.some(device=>device.deviceId===_radioMicDeviceId)){
      const current=physical.find(device=>
        defaultDevice&&defaultDevice.groupId&&device.groupId===defaultDevice.groupId);
      _radioMicDeviceId=(current||physical[0]).deviceId;
      localStorage.setItem('flyfrancevfr_radio_mic_device_id',_radioMicDeviceId);
    }
    select.value=_radioMicDeviceId;
    const selected=physical.find(device=>device.deviceId===_radioMicDeviceId);
    updateRadioDefaultMicrophoneLabel(selected&&selected.label);
  }catch(e){
    console.warn('Liste des microphones indisponible',e);
  }
}

function selectRadioInputDevice(deviceId){
  const select=document.getElementById('radio-mic-select');
  const option=select&&select.options[select.selectedIndex];
  if(!deviceId||!option)return;
  _radioMicDeviceId=deviceId;
  _radioMicDeviceLabel=option.textContent||'Microphone';
  localStorage.setItem('flyfrancevfr_radio_mic_device_id',_radioMicDeviceId);
  _micPermissionVerified=false;
  if(window.chrome&&window.chrome.webview){
    window.chrome.webview.postMessage(
      'set-default-microphone:'+encodeURIComponent(_radioMicDeviceLabel));
  }else{
    showNotif('Le changement de microphone nécessite l’application Windows');
  }
}

async function requestMicrophonePermission(options={}){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return true;
  if(_micPermissionVerified)return true;
  const silent=!!options.silent;
  const delays=[0,350,700,1200,1800,2500,3500,5000,6000,8000];
  let lastError=null;
  for(let attempt=0;attempt<delays.length;attempt++){
    if(delays[attempt])await radioSleep(delays[attempt]);
    try{
      if(!silent&&attempt>0)setRadioTranscript(radioStatusMessage('micInitializing',{attempt:attempt+1,total:delays.length},`Initialisation micro en cours... tentative ${attempt+1}/${delays.length}`));
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const defaultTrack=stream.getAudioTracks()[0];
      updateRadioDefaultMicrophoneLabel(defaultTrack&&defaultTrack.label);
      stream.getTracks().forEach(t=>t.stop());
      _micPermissionVerified=true;
      await refreshRadioInputDevices();
      return true;
    }catch(e){
      lastError=e;
      console.warn(`Autorisation micro indisponible tentative ${attempt+1}`,e);
    }
  }
  console.warn('Autorisation micro refusée',lastError);
  if(!silent){
    setRadioTranscript(radioStatusMessage('micDenied',{},'Micro refusé ou indisponible. Vérifiez les autorisations micro Windows pour FlyFranceVFR, puis relancez l’application.'));
    showNotif(radioStatusMessage('micUnavailableNotif',{},'Micro FlyFranceVFR indisponible'));
  }
  return false;
}

const RADIO_ALPHA_WORDS={
  A:'Alpha',B:'Bravo',C:'Charlie',D:'Delta',E:'Echo',F:'Fox',G:'Golf',H:'Hotel',I:'India',
  J:'Juliet',K:'Kilo',L:'Lima',M:'Mike',N:'November',O:'Oscar',P:'Papa',Q:'Quebec',R:'Romeo',
  S:'Sierra',T:'Tango',U:'Uniform',V:'Victor',W:'Whiskey',X:'X-ray',Y:'Yankee',Z:'Zulu',
  0:'zéro',1:'unité',2:'deux',3:'trois',4:'quatre',5:'cinq',6:'six',7:'sept',8:'huit',9:'neuf'
};

function radioSpeakHoldingRef(ref){
  return String(ref||'').toUpperCase().split('').map(ch=>RADIO_ALPHA_WORDS[ch]||ch).join(' ');
}

function radioSpeakCallsignRef(ref){
  const clean=String(ref||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!clean)return '';
  return clean.split('').map(ch=>RADIO_ALPHA_WORDS[ch]||ch).join(' ');
}

function radioSpeakFrequencyValue(value){
  const digitWords={0:'zéro',1:'unité',2:'deux',3:'trois',4:'quatre',5:'cinq',6:'six',7:'sept',8:'huit',9:'neuf'};
  const parts=String(value||'').split('.');
  if(parts.length!==2)return String(value||'');
  // Sur un canal tel que 118.300, les deux zéros finaux ne sont pas transmis.
  // Les autres canaux à trois décimales (118.025, 118.050...) restent complets.
  const decimals=/^\d00$/.test(parts[1])?parts[1][0]:parts[1];
  return `${parts[0].split('').map(ch=>digitWords[ch]||ch).join(' ')}, décimale ${decimals.split('').map(ch=>digitWords[ch]||ch).join(' ')}`;
}

function radioSpeechText(text){
  const runwaySuffixNames={L:'gauche',R:'droite',C:'centrale'};
  return normalizeSpeechText(text)
    // « nœuds » se prononce « neu » : le d et le s restent muets.
    .replace(/\b(?:nœuds|noeuds)\b/gi,'neu')
    .replace(/\bvent\s+(du\s+)?0(\d{2})\s+degr[ée]s\b/gi,(m,prefix,degrees)=>`vent ${prefix||''}${degrees} degrés`)
    .replace(/\bEnregistrée à 0([0-9]) heures\b/gi,'Enregistrée à $1 heures')
    // En phraséologie française, 12L, 12R et 12C se prononcent respectivement
    // « piste douze gauche », « piste douze droite » et « piste douze centrale ».
    .replace(/\b(\d{1,2})([LRC])\b/gi,(m,number,suffix)=>
      `${number}, ${runwaySuffixNames[String(suffix).toUpperCase()]}`)
    .replace(/\b1[1-3]\d\.\d{3}\b/g,value=>radioSpeakFrequencyValue(value))
    // L'unité reste implicite en radiotéléphonie : on ne prononce jamais « mégahertz ».
    .replace(/\s*\b(?:MHz|mégahertz)\b/gi,'')
    .replace(/\bArcachon\s+Info\b/gi,'Arcachon, Info')
    .replace(/\b([A-Z]{2})-([A-Z]{1,3})\b/g,(m,prefix,suffix)=>
      `${radioSpeakCallsignRef(prefix)} ${radioSpeakCallsignRef(suffix)}`)
    .replace(/\bpoint\s+([A-Z]{1,3})\b/g,(m,code)=>`point ${radioSpeakCallsignRef(code)}`)
    .replace(/\binformation\s+([A-Z])\b/gi,(m,letter)=>{
      const code=String(letter).toUpperCase();
      return `information ${RADIO_ALPHA_WORDS[code]||code}`;
    })
    .replace(/\bF-([A-Z0-9]{2,4})\b/g,(m,tail)=>radioSpeakCallsignRef(`F${tail}`))
      .replace(/\btranspondeur\s+([0-7]{4})\b/gi,(m,code)=>`transpondeur ${code.split('').map(ch=>RADIO_ALPHA_WORDS[ch]||ch).join(' ')}`)
      .replace(/\bcode\s+([0-7]{4})\b/gi,(m,code)=>`code ${code.split('').map(ch=>RADIO_ALPHA_WORDS[ch]||ch).join(' ')}`)
    .replace(/point d['’]attente\s*--\s*,?\s*piste\b/gi,"point d'attente, piste")
    .replace(/point d['’]attente\s*--\s*,?\s*de la piste\b/gi,"point d'attente de la piste")
    .replace(/point d['’]attente\s*--(?=\s|,|\.|$)/gi,"point d'attente")
    .replace(/point d['’]attente\s+([A-Z]{1,2}\d{0,2})\s+piste\b/gi,(m,ref)=>`point d'attente, ${radioSpeakHoldingRef(ref)}, piste`)
    .replace(/point d['’]attente\s+([A-Z]{1,2}\d{0,2})\b/gi,(m,ref)=>`point d'attente, ${radioSpeakHoldingRef(ref)}`)
    .replace(/\s*--\s*/g,' ')
    // « DR400 » serait lu « docteur quatre cents » : on épelle D R.
    .replace(/\bDR\s*-?\s*(\d{3})\b/g,'D R $1')
    .replace(/VFR/g,'V F R')
    .replace(/QNH/g,'Q N H')
    .replace(/UTC/g,'U T C')
    .replace(/ATIS/g,'A T I S');
}

// Attribution des voix aux pilotes IA : chaque pilote reçoit une voix française différente
// (de préférence du genre indiqué par son profil), tant qu'il en reste d'inutilisées.
const _aiPilotVoiceAssignments=new Map();
const RADIO_FEMALE_VOICE_RE=/denise|vivienne|eloise|éloïse|brigitte|coralie|jacqueline|josephine|joséphine|yvette|female|femme|hortense|julie|celine|céline/i;
const RADIO_MALE_VOICE_RE=/henri|remy|rémy|alain|jerome|jérôme|maurice|yves|claude|male|homme|paul|thomas/i;
function radioAssignAIPilotVoice(pilotId,hint,voices){
  const known=_aiPilotVoiceAssignments.get(pilotId);
  if(known){const v=voices.find(x=>x.name===known);if(v)return v;}
  const gender=v=>RADIO_FEMALE_VOICE_RE.test(v.name||'')?'f':RADIO_MALE_VOICE_RE.test(v.name||'')?'m':'?';
  const wantFemale=RADIO_FEMALE_VOICE_RE.test(hint||'');
  const wantMale=!wantFemale&&RADIO_MALE_VOICE_RE.test(hint||'');
  const want=wantFemale?'f':wantMale?'m':null;
  const used=new Set(_aiPilotVoiceAssignments.values());
  // La voix de l'agent AFIS/radio est réservée : aucun pilote IA ne la prend.
  // Les voix sol et ATIS sont évitées tant qu'il reste d'autres voix.
  const afisVoice=radioVoiceForRole('afis');
  const hard=new Set(afisVoice?[afisVoice.name]:[]);
  const soft=new Set();
  ['ground','atis'].forEach(r=>{const v=radioVoiceForRole(r);if(v)soft.add(v.name);});
  const free=voices.filter(v=>!used.has(v.name)&&!hard.has(v.name));
  const freeStrict=free.filter(v=>!soft.has(v.name));
  let pick=(want&&freeStrict.find(v=>gender(v)===want))||(want&&free.find(v=>gender(v)===want))||freeStrict[0]||free[0]||null;
  if(!pick){
    // Toutes les voix sont déjà prises : réutiliser une voix du même genre, jamais celle de l'AFIS
    // (le timbre sera décalé par la hauteur et le débit).
    const base=voices.filter(v=>!hard.has(v.name));
    const pool=base.filter(v=>!want||gender(v)===want||gender(v)==='?');
    const list=pool.length?pool:(base.length?base:voices);
    pick=list[_aiPilotVoiceAssignments.size%list.length];
  }
  if(pick)_aiPilotVoiceAssignments.set(pilotId,pick.name);
  console.info('[Traffic IA Radio] Voix pilote',pilotId,'->',pick&&pick.name,'| AFIS :',afisVoice&&afisVoice.name);
  return pick||null;
}
const _aiPilotSlots=new Map();
function radioAIPilotSlot(pilotId){
  if(!_aiPilotSlots.has(pilotId))_aiPilotSlots.set(pilotId,_aiPilotSlots.size);
  return _aiPilotSlots.get(pilotId);
}

function radioVoiceForRole(role,customProfile=null){
  const voices=(window.speechSynthesis&&window.speechSynthesis.getVoices?window.speechSynthesis.getVoices():[])
    .filter(v=>/^fr/i.test(v.lang||''));
  if(!voices.length)return null;
  const cachedName=_radioVoiceCache[role];
  if(cachedName){
    const cachedVoice=voices.find(v=>v.name===cachedName);
    if(cachedVoice)return cachedVoice;
  }
  const defaultVoice=voices.find(v=>v.default)||voices[0];
  const hint=String(customProfile&&(customProfile.voiceHint||customProfile.voice)||'').toLowerCase();
  if(String(role||'').startsWith('ai-pilot')){
    if(customProfile&&customProfile.pilotId){
      const assigned=radioAssignAIPilotVoice(String(customProfile.pilotId),hint,voices);
      if(assigned)return assigned;
    }
    const female=/denise|female|femme|hortense|julie|celine|céline/i.test(hint);
    const male=/henri|male|homme|paul|thomas|claude/i.test(hint);
    const matching=voices.filter(v=>female?/denise|female|femme|hortense|julie|celine|céline/i.test(v.name||''):male?/henri|male|homme|paul|thomas|claude/i.test(v.name||''):true);
    const pool=matching.length?matching:voices;
    const index=Math.abs(Number(customProfile&&customProfile.voiceIndex)||0)%pool.length;
    return pool[index]||defaultVoice;
  }
  const preferredRadio=voices.find(v=>/paul|henri|claude|thomas|male|homme/i.test(v.name||''))||voices[1]||voices[0];
  const preferredGround=voices.find(v=>v!==defaultVoice&&/paul|henri|claude|thomas|male|homme/i.test(v.name||''))
    ||voices.find(v=>v!==defaultVoice)
    ||preferredRadio;
  const preferredPilot=voices.find(v=>v!==preferredRadio)||voices[0];
  const preferredAtis=voices.find(v=>v!==preferredRadio&&v!==preferredPilot&&/denise|hortense|julie|celine|female|femme/i.test(v.name||''))
    ||voices.find(v=>v!==preferredRadio&&v!==preferredPilot)
    ||voices.find(v=>v!==preferredRadio)
    ||voices[0];
  const selected=role==='atis'?preferredAtis:role==='ground'?preferredGround:
    (role==='radio'||role==='afis'||role==='siv'||role==='tower')?preferredRadio:preferredPilot;
  if(selected)_radioVoiceCache[role]=selected.name;
  return selected;
}

function applyRadioVoiceProfile(utterance,role,customProfile=null){
  const voice=radioVoiceForRole(role,customProfile);
  const externalProfile=(RADIO_CONFIG.voiceProfiles&&RADIO_CONFIG.voiceProfiles[role])||{};
  const profile=customProfile&&typeof customProfile==='object'?customProfile:externalProfile;
  if(voice)utterance.voice=voice;
  utterance.lang='fr-FR';
  utterance.rate=Number(profile.rate)||(role==='atis'?0.84:role==='ground'?0.88:role==='radio'?0.9:0.96);
  utterance.pitch=Number(profile.pitch)||(role==='atis'?0.92:role==='ground'?0.72:role==='radio'?0.78:1.05);
  utterance.volume=Number(profile.volume)||1;
}

// Ambiance sonore discrète réservée aux pilotes Traffic IA : moteur lointain
// + souffle radio/micro. La voix reste la synthèse vocale existante.
let _aiRadioAmbience = null;
function startAIPilotRadioAmbience(){
  try{
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx)return null;
    if(!_aiRadioAmbience){
      const ctx=new Ctx();
      const master=ctx.createGain();master.gain.value=0.0001;master.connect(ctx.destination);
      const engine=ctx.createGain();engine.gain.value=0.0001;engine.connect(master);
      const low=ctx.createOscillator(),harmonic=ctx.createOscillator();
      low.type='sawtooth';low.frequency.value=54;
      harmonic.type='triangle';harmonic.frequency.value=108;
      const engineFilter=ctx.createBiquadFilter();engineFilter.type='lowpass';engineFilter.frequency.value=170;
      low.connect(engineFilter);harmonic.connect(engineFilter);engineFilter.connect(engine);
      low.start();harmonic.start();
      const buffer=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);
      const data=buffer.getChannelData(0);
      for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*0.35;
      const noise=ctx.createBufferSource();noise.buffer=buffer;noise.loop=true;
      const radioFilter=ctx.createBiquadFilter();radioFilter.type='bandpass';radioFilter.frequency.value=1450;radioFilter.Q.value=0.7;
      const radioGain=ctx.createGain();radioGain.gain.value=0.0001;
      noise.connect(radioFilter);radioFilter.connect(radioGain);radioGain.connect(master);noise.start();
      _aiRadioAmbience={ctx,master,engine,radioGain,low,harmonic,noise};
    }
    const a=_aiRadioAmbience;
    if(a.ctx.state==='suspended')a.ctx.resume().catch(()=>{});
    const t=a.ctx.currentTime;
    a.master.gain.cancelScheduledValues(t);a.master.gain.setTargetAtTime(0.42,t,0.08);
    a.engine.gain.cancelScheduledValues(t);a.engine.gain.setTargetAtTime(0.11,t,0.12);
    a.radioGain.gain.cancelScheduledValues(t);a.radioGain.gain.setTargetAtTime(0.035,t,0.05);
    // Petit squelch d'ouverture de micro, sans couvrir la phrase.
    a.radioGain.gain.setValueAtTime(0.075,t+0.06);
    a.radioGain.gain.setTargetAtTime(0.035,t+0.16,0.06);
    return a;
  }catch(e){console.debug('[Radio IA] Ambiance audio indisponible',e);return null;}
}
function stopAIPilotRadioAmbience(){
  const a=_aiRadioAmbience;if(!a)return;
  try{
    const t=a.ctx.currentTime;
    a.master.gain.cancelScheduledValues(t);a.master.gain.setTargetAtTime(0.0001,t,0.12);
    a.engine.gain.cancelScheduledValues(t);a.engine.gain.setTargetAtTime(0.0001,t,0.1);
    a.radioGain.gain.cancelScheduledValues(t);a.radioGain.gain.setTargetAtTime(0.0001,t,0.08);
  }catch(e){}
}

function radioSpeechQueueBusy(){
  return _radioSpeechActive||_radioSpeechQueue.length>0||!!_radioSpeechQueueTimer;
}

function radioSpeechShowItem(item){
  // Les pilotes Traffic IA sont audibles, mais leurs messages restent dans
  // l'encart dédié du module Traffic IA et ne polluent pas l'onglet Radio.
  // Les réponses AFIS destinées aux avions IA sont audibles mais jamais affichées ici
  // (l'encart AFIS de l'onglet Radio est réservé aux échanges du pilote).
  if(item.role==='ai-pilot'||item.hideFromRadioTab)return;
  const reply=document.getElementById('radio-reply');
  if(item.role==='pilot')setRadioTranscript(item.text);
  else{
    _lastRadioReply=item.text;
    if(reply)reply.textContent=item.text;
  }
}

function processRadioSpeechQueue(){
  if(_radioSpeechActive||_radioSpeechQueueTimer||!_radioSpeechQueue.length)return;
  if(_radioListening||_radioPushToTalk||
    (window.speechSynthesis&&(window.speechSynthesis.speaking||window.speechSynthesis.pending))){
    _radioSpeechQueueTimer=setTimeout(()=>{
      _radioSpeechQueueTimer=null;
      processRadioSpeechQueue();
    },200);
    return;
  }
  const nextItem=_radioSpeechQueue[0];
  const requiredGap=Number.isFinite(nextItem&&nextItem.gapBeforeMs)?Math.max(0,nextItem.gapBeforeMs):0;
  const remainingGap=requiredGap-(Date.now()-_radioSpeechLastEndedAt);
  if(remainingGap>0){
    _radioSpeechQueueTimer=setTimeout(()=>{
      _radioSpeechQueueTimer=null;
      processRadioSpeechQueue();
    },remainingGap);
    return;
  }
  const item=_radioSpeechQueue.shift();
  if(!item)return;
  if(item.expiresAt&&Date.now()>item.expiresAt){
    if(typeof item.onComplete==='function')item.onComplete(false);
    processRadioSpeechQueue();
    return;
  }
  radioSpeechShowItem(item);
  if(!voiceGuidanceAvailable()){
    _radioSpeechLastEndedAt=Date.now();
    if(typeof item.onComplete==='function')item.onComplete(true);
    processRadioSpeechQueue();
    return;
  }
  try{
    unlockVoiceGuidance();
    const u=new SpeechSynthesisUtterance(radioSpeechText(item.text));
    applyRadioVoiceProfile(u,item.role,item.voiceProfile||null);
    _radioSpeechActive=true;
    const aiAmbience=item.role==='ai-pilot'?startAIPilotRadioAmbience():null;
    let finished=false;
    const finish=delivered=>{
      if(finished)return;
      finished=true;
      _radioSpeechActive=false;
      if(item.role==='ai-pilot')stopAIPilotRadioAmbience();
      _radioSpeechLastEndedAt=Date.now();
      if(typeof item.onComplete==='function')item.onComplete(!!delivered);
      processRadioSpeechQueue();
    };
    u.onend=()=>finish(true);
    u.onerror=()=>finish(false);
    window.speechSynthesis.speak(u);
  }catch(e){
    console.warn('Radio vocale indisponible',e);
    _radioSpeechActive=false;
    if(item.role==='ai-pilot')stopAIPilotRadioAmbience();
    _radioSpeechLastEndedAt=Date.now();
    if(typeof item.onComplete==='function')item.onComplete(false);
    processRadioSpeechQueue();
  }
}

function enqueueRadioSpeech(text,role='radio',maxWaitMs=120000,onComplete=null,gapBeforeMs=0,voiceProfile=null,options=null){
  const msg=String(text||'').replace(/\s+/g,' ').trim();
  if(!msg)return false;
  if(_activeAtisBroadcastKey&&role!=='atis')return false;
  _radioSpeechQueue.push({
    text:msg,
    role,
    expiresAt:Number.isFinite(maxWaitMs)&&maxWaitMs>0?Date.now()+maxWaitMs:0,
    onComplete,
    gapBeforeMs,
    voiceProfile:voiceProfile&&typeof voiceProfile==='object'?{...voiceProfile}:null,
    hideFromRadioTab:!!(options&&options.hideFromRadioTab)
  });
  processRadioSpeechQueue();
  return true;
}

function radioSpeak(text,role='radio'){
  return enqueueRadioSpeech(text,role,120000,null);
}

function radioSpeakWhenIdle(text,role='radio',maxWaitMs=30000,onComplete=null,gapBeforeMs=0,options=null){
  const queued=enqueueRadioSpeech(text,role,maxWaitMs,onComplete,gapBeforeMs,null,options);
  if(!queued&&typeof onComplete==='function')onComplete(false);
  return queued;
}

// Annonces des pilotes fictifs Traffic IA. Chaque pilote garde une signature
// vocale stable : timbre local selon le profil (Henri/Denise), puis variations
// légères de débit et de hauteur calculées à partir de son identifiant.
function radioSpeakAIPilot(text,pilot={},onComplete=null){
  const id=String(pilot.id||pilot.pilot_id||'pilot-01');
  let hash=0;for(let i=0;i<id.length;i++)hash=((hash*31)+id.charCodeAt(i))>>>0;
  const voiceHint=String(pilot.voice||'');
  // Chaque pilote reçoit un créneau (ordre de première prise de parole) qui décale
  // franchement hauteur et débit, même si deux pilotes devaient partager la même voix.
  const SLOT_PITCH=[0.98,1.12,1.05,1.18,0.94,1.10];
  const SLOT_RATE=[0.95,1.0,0.91,0.98,0.93,1.02];
  const slot=radioAIPilotSlot(id)%SLOT_PITCH.length;
  const profile={
    voiceHint,
    pilotId:id,
    voiceIndex:hash,
    rate:SLOT_RATE[slot]+((hash>>>4)%3)/100,
    pitch:SLOT_PITCH[slot]+(hash%3)/100,
    volume:1
  };
  return enqueueRadioSpeech(text,'ai-pilot',0,onComplete,0,profile);
}

function radioSpeakSequence(messages){
  const queue=(Array.isArray(messages)?messages:[messages]).map((x,idx)=>{
    if(x&&typeof x==='object')return {text:String(x.text||'').replace(/\s+/g,' ').trim(),role:x.role||'radio'};
    return {text:String(x||'').replace(/\s+/g,' ').trim(),role:idx===0?'pilot':'radio'};
  }).filter(x=>x.text);
  if(!queue.length)return false;
  if(_activeAtisBroadcastKey)return false;
  const voiceAvailable=voiceGuidanceAvailable();
  queue.forEach(item=>enqueueRadioSpeech(item.text,item.role,120000,null));
  return voiceAvailable;
}

function airportByIcao(icao){
  const code=String(icao||'').toUpperCase();
  return AIRPORTS.find(a=>String(a.icao||'').toUpperCase()===code)||null;
}

function nearestAirportTo(lat,lon,maxNm=12){
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Array.isArray(AIRPORTS))return null;
  let best=null;
  AIRPORTS.forEach(a=>{
    const d=distNM(lat,lon,a.lat,a.lon);
    if(d<=maxNm&&(!best||d<best.d))best={...a,d};
  });
  return best;
}

function radioAirportCommRangeNm(a){
  const services=radioServicesForAirport(a&&a.icao);
  if(services.some(s=>s.type==='tower'))return 45;
  if(services.some(s=>s.type==='afis'||s.type==='info'))return 30;
  return 20;
}

function activeAirportRadioServiceForAirport(icao){
  return activeRadioServiceForAirport(icao,{includeSiv:false});
}

function currentRadioAirport(){
  const d=_lastSimData||{};
  const hasPos=hasValidSimData(d);
  const lat=Number(d.lat),lon=Number(d.lon);
  const candidates=[];
  const addCandidate=(a)=>{
    if(!a||!a.icao||candidates.some(x=>x&&x.icao===a.icao))return;
    candidates.push(a);
  };
  if(activeMission&&activeMission.from)addCandidate(airportByIcao(activeMission.from));
  if(activeMission&&activeMission.destAP)addCandidate(activeMission.destAP);
  if(hasPos){
    AIRPORTS.forEach(a=>{
      const dist=distNM(lat,lon,a.lat,a.lon);
      if(dist<=radioAirportCommRangeNm(a))addCandidate({...a,d:dist});
    });
    // Le plus proche d'abord : sinon, entre deux terrains voisins (ex. LFCD /
    // LFCH), le terrain de départ de la mission reste prioritaire à l'arrivée.
    const distOf=a=>Number.isFinite(a.d)?a.d:distNM(lat,lon,a.lat,a.lon);
    candidates.sort((x,y)=>distOf(x)-distOf(y));
    for(const a of candidates){
      const dist=distOf(a);
      if(dist<=radioAirportCommRangeNm(a)&&activeAirportRadioServiceForAirport(a.icao))return {...a,d:dist};
    }
  }
  if(activeMission&&activeMission.from&&['preflight','startup','takeoff'].includes(missionPhase||activeMission.phase||'preflight')){
    const a=airportByIcao(activeMission.from);
    if(a)return a;
  }
  if(activeMission&&activeMission.destAP&&hasPos){
    const a=activeMission.destAP;
    const dist=distNM(lat,lon,a.lat,a.lon);
    if(dist<=radioAirportCommRangeNm(a))return {...a,d:dist};
  }
  if(hasPos){
    const a=nearestAirportTo(lat,lon,15);
    if(a)return a;
  }
  if(activeMission&&activeMission.from){
    const a=airportByIcao(activeMission.from);
    if(a)return a;
  }
  if(selectedAP)return selectedAP;
  if(pilot.baseIcao)return airportByIcao(pilot.baseIcao);
  return airportByIcao('LFBD')||AIRPORTS[0]||null;
}

function validateActiveMissionStartPosition(d,show=true){
  if(!activeMission||!activeMission.from)return true;
  const earlyPhases=['preflight','startup','takeoff'];
  if(!earlyPhases.includes(missionPhase||activeMission.phase||'preflight'))return true;
  if(!d||!hasValidSimData(d))return true;
  const dep=airportByIcao(activeMission.from);
  if(!dep)return true;
  const distToDep=distNM(Number(d.lat),Number(d.lon),dep.lat,dep.lon);
  if(distToDep<=5){
    _missionStartPositionWarnedThisConnection=false;
    _missionStartWrongSamples=0;
    _missionStartWrongFirstAt=0;
    return true;
  }
  const now=Date.now();
  if(!_missionStartWrongFirstAt)_missionStartWrongFirstAt=now;
  _missionStartWrongSamples++;
  if(_missionStartWrongSamples<3||now-_missionStartWrongFirstAt<2500){
    console.warn('[Mission] position départ suspecte ignorée temporairement', activeMission.from, Math.round(distToDep), 'NM');
    return true;
  }
  if(show&&!_missionStartPositionWarnedThisConnection){
    const nearest=nearestAirportTo(Number(d.lat),Number(d.lon),15)||findNearestAP(Number(d.lat),Number(d.lon),15);
    const nearestName=nearest?`${nearest.icao} — ${nearest.name}`:'position inconnue';
    showMissionBanner(`⚠ Mauvais aérodrome de départ<br>Mission prévue depuis <b>${htmlEscape(dep.icao)}</b><br>Position actuelle : <b>${htmlEscape(nearestName)}</b> (${Math.round(distToDep)} nm)`,'#ff5555');
    setTimeout(hideMissionBanner,8000);
    showNotif(`⚠ Mission au départ de ${dep.icao}`);
    _missionStartPositionWarnedThisConnection=true;
  }
  return false;
}

function radioServiceForAirport(icao){
  const services=radioServicesForAirport(icao);
  return services.find(s=>s.type==='atis')
      || services.find(s=>s.type==='afis')
      || services.find(s=>s.type==='tower')
      || services.find(s=>s.type==='info')
      || services.find(s=>s.type==='ground')
      || {type:'auto',label:'Auto-information',freq:'123.500',desc:'AUTO INFORMATION'};
}

function radioFreqValue(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<=0)return null;
  if(n>=1000000)return n/1000000;
  if(n>=100000)return n/1000;
  if(n>=100&&n<=200)return n;
  const i=Math.round(n);
  if(i>0&&i<=0x9999){
    const d=[(i>>12)&15,(i>>8)&15,(i>>4)&15,i&15];
    if(d.every(x=>x>=0&&x<=9)){
      const mhz=100+d[0]*10+d[1]+d[2]/10+d[3]/100;
      if(mhz>=100&&mhz<=200)return mhz;
    }
  }
  return n;
}

function radioFreqText(v){
  const n=radioFreqValue(v);
  return n?Number(n).toFixed(3):'---';
}

function radioFreqMatches(a,b){
  const fa=radioFreqValue(a),fb=radioFreqValue(b);
  return fa&&fb&&Math.abs(fa-fb)<0.006;
}

function radioTransmitIndex(d=_lastSimData||{}){
  if(d&&d.com1_transmit===true&&d.com2_transmit!==true)return 1;
  if(d&&d.com2_transmit===true&&d.com1_transmit!==true)return 2;
  if(d&&d.com1_transmit===true)return 1;
  if(d&&d.com2_transmit===true)return 2;
  const n=Number(d&&d.com_transmit);
  return n===1||n===2?n:0;
}

function radioComCandidates(d=_lastSimData||{}){
  const all=[
    {index:1,radio:'COM1',freq:d.com1_active},
    {index:2,radio:'COM2',freq:d.com2_active}
  ];
  const tx=radioTransmitIndex(d);
  return tx?all.filter(c=>c.index===tx):all;
}

function radioActiveComText(d=_lastSimData||{}){
  const rows=[];
  const c1=radioFreqValue(d.com1_active);
  const c2=radioFreqValue(d.com2_active);
  if(c1)rows.push(`COM1 ${c1.toFixed(3)}`);
  if(c2)rows.push(`COM2 ${c2.toFixed(3)}`);
  return rows.join(' · ');
}

const AIRPORT_SIV_INFO_CACHE={};

function airportInfoIsSiv(icao,entry){
  const cacheKey=`${String(icao||'').toUpperCase()}|${String(entry&&entry.freq||'')}|${String(entry&&entry.desc||'')}`;
  if(Object.prototype.hasOwnProperty.call(AIRPORT_SIV_INFO_CACHE,cacheKey))return AIRPORT_SIV_INFO_CACHE[cacheKey];
  const desc=normalizePoiText(entry&&entry.desc||'');
  if(!desc||desc==='a a'||desc.includes('auto information'))return AIRPORT_SIV_INFO_CACHE[cacheKey]=false;
  if(/\b(siv|fis)\b/.test(desc))return AIRPORT_SIV_INFO_CACHE[cacheKey]=true;
  const airport=airportByIcao(icao);
  const features=sivFeatures.length?sivFeatures:(typeof SIV_DATA!=='undefined'&&SIV_DATA.features?SIV_DATA.features:[]);
  const result=features.some(feature=>{
    const siv=normalizeSivFeature(feature);
    if(!siv)return false;
    const sameFreq=!!(entry&&entry.freq&&siv.freq&&radioFreqMatches(entry.freq,siv.freq));
    const coversAirport=!!(airport&&pointInGeometry(Number(airport.lat),Number(airport.lon),feature.geometry));
    const base=normalizePoiText(siv.name||'').replace(/^siv\s+/,'').replace(/\s+(nord|sud|est|ouest)$/,'').trim();
    const nameMatch=!!(base&&desc.includes(base)&&(desc.includes('information')||desc.includes('info')));
    return (sameFreq&&coversAirport)||(sameFreq&&nameMatch)||nameMatch;
  });
  AIRPORT_SIV_INFO_CACHE[cacheKey]=result;
  return result;
}

function radioServicesForAirport(icao){
  const airportIcao=String(icao||'').toUpperCase();
  const f=AP_FREQS[airportIcao]||{};
  const defs=[
    ['atis','ATIS',f.atis],
    ['ground','Sol',f.ground],
    ['tower','Tour',f.tower],
    ['afis','AFIS',f.afis],
    ['info','Information',f.info]
  ];
  const rows=[];
  defs.forEach(([type,label,list])=>{
    (list||[]).forEach(x=>{
      if(type==='info'&&airportInfoIsSiv(airportIcao,x))return;
      rows.push({type,label,freq:x.freq||'',desc:x.desc||label});
    });
  });
  if(!rows.length)rows.push({type:'auto',label:'Auto-information',freq:'123.500',desc:'AUTO INFORMATION'});
  return rows;
}

function radioAirportUsesAirToAir(icao){
  const services=radioServicesForAirport(icao);
  const controlled=services.some(s=>['atis','ground','tower','afis'].includes(s.type));
  return !controlled&&services.some(s=>s.type==='info'||s.type==='auto');
}

function activeRadioServiceForAirport(icao,options={}){
  const services=radioServicesForAirport(icao);
  const d=_lastSimData||{};
  const coms=radioComCandidates(d);
  if(options.includeSiv!==false&&hasValidSimData(d)){
    const siv=getSivAt(Number(d.lat),Number(d.lon));
    if(siv&&siv.freq){
      for(const com of coms){
        if(radioFreqMatches(com.freq,siv.freq)){
          return {type:'siv',label:'SIV',freq:siv.freq,desc:siv.info||siv.name||'Information',siv,radio:com.radio,activeFreq:radioFreqText(com.freq),matched:true};
        }
      }
    }
  }
  for(const com of coms){
    const match=services.find(s=>radioFreqMatches(com.freq,s.freq));
    if(match){
      const matched={...match,radio:com.radio,activeFreq:radioFreqText(com.freq),matched:true};
      if(radioAirportUsesAirToAir(icao)){
        return {...matched,type:'auto',label:'A/A',desc:matched.desc||'AUTO INFORMATION'};
      }
      return matched;
    }
  }
  return null;
}

function currentValidatedRadioContext(){
  const a=currentRadioAirport();
  const service=activeRadioServiceForAirport(a&&a.icao);
  if(service){
    _radioValidatedAirport=a;
    _radioValidatedService=service;
  }else{
    _radioValidatedAirport=null;
    _radioValidatedService=null;
  }
  return {airport:a,service};
}

function requiredRadioFreqText(a){
  const services=radioServicesForAirport(a&&a.icao);
  return services.slice(0,5).map(s=>`${s.label} ${s.freq}`).join(' · ');
}

function isAirToAirService(service){
  const s=normalizePoiText([service&&service.type,service&&service.label,service&&service.desc].filter(Boolean).join(' '));
  return !service || service.type==='auto' || s.includes('a/a') || s.includes('auto info') || s.includes('auto-information') || s.includes('auto information');
}

function isSivService(service){
  if(!service)return false;
  if(service.type==='siv')return true;
  const raw=[service.type,service.label,service.desc,service.siv&&service.siv.name,service.siv&&service.siv.info].filter(Boolean).join(' ');
  const s=normalizePoiText(raw);
  return /\bsiv\b/i.test(s)||/\bfis\b/i.test(s);
}

function radioFallbackServiceForAirport(a){
  const services=radioServicesForAirport(a&&a.icao);
  const fallback=radioServiceForAirport(a&&a.icao);
  if(radioAirportUsesAirToAir(a&&a.icao)){
    const info=services.find(s=>s.type==='info')||fallback;
    return {...info,type:'auto',label:'A/A',desc:info.desc||'AUTO INFORMATION'};
  }
  return fallback;
}

function normalizeFrenchRegistration(value){
  const raw=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(/^F[A-Z0-9]{4}$/.test(raw))return raw.slice(0,1)+'-'+raw.slice(1);
  return '';
}

function savedRadioRegistration(){
  try{return normalizeFrenchRegistration(localStorage.getItem('fvfr_radio_registration')||'');}
  catch(e){return '';}
}

function pilotRegistration(){
  return normalizeFrenchRegistration(pilot&&pilot.registration)
      || savedRadioRegistration()
      || '';
}

function liveMsfsRegistration(){
  const d=_lastSimData||{};
  return normalizeFrenchRegistration(d.atc_id)
      || normalizeFrenchRegistration(d.aircraft_registration)
      || '';
}

function radioCallsign(){
  return liveMsfsRegistration();
}

function radioShortCallsign(cs=radioCallsign()||pilotRegistration()){
  const reg=normalizeFrenchRegistration(cs);
  if(!reg)return cs||'F-XX';
  const tail=reg.replace(/^F-/,'');
  return `F-${tail.slice(-2)}`;
}

function adoptMsfsRegistrationIfUnset(msfsReg){
  const reg=normalizeFrenchRegistration(msfsReg);
  if(!reg)return false;
  const current=normalizeFrenchRegistration(pilot&&pilot.registration);
  const saved=savedRadioRegistration();
  if(current||saved)return false;
  pilot.registration=reg;
  try{localStorage.setItem('fvfr_radio_registration',reg);}catch(e){}
  try{save();}catch(e){}
  return true;
}

async function syncRegistrationToMsfs(reg=pilotRegistration()){
  const normalized=normalizeFrenchRegistration(reg);
  if(!normalized){showNotif('Format attendu : F-XXXX');return false;}
  const status=document.getElementById('pilot-reg-status');
  if(status)status.textContent=`Souhaitée : ${normalized} · en attente de confirmation par MSFS`;
  try{
    const resp=await fetch(`/api/registration?value=${encodeURIComponent(normalized)}`);
    const data=await resp.json().catch(()=>null);
    if(!resp.ok||!data||!data.ok)throw new Error(data&&data.message?data.message:'bridge indisponible');
    // MSFS peut accepter l'ATC ID rapidement tout en ne le renvoyant ou ne
    // rafraîchissant la livrée que bien plus tard. On attend donc 90 secondes
    // avant de considérer que la confirmation manque.
    for(let i=0;i<180;i++){
      await new Promise(resolve=>setTimeout(resolve,500));
      const liveReg=normalizeFrenchRegistration((_lastSimData||{}).atc_id)||normalizeFrenchRegistration((_lastSimData||{}).aircraft_registration);
      if(liveReg===normalized){
        updatePilotRegistrationUI();
        showNotif(`Immatriculation MSFS confirmée : ${normalized}`);
        return true;
      }
      const stResp=await fetch('/api/registration-status');
      const st=await stResp.json().catch(()=>null);
      if(st&&st.ok===true){
        updatePilotRegistrationUI();
        showNotif(`Immatriculation MSFS confirmée : ${normalized}`);
        return true;
      }
      // Un ancien bridge peut déclarer l'absence de télémétrie comme un échec
      // après quelques secondes. Ce n'est pas un refus de MSFS : on continue
      // d'attendre l'ATC ID réellement renvoyé par la télémétrie.
    }
    throw new Error('Confirmation MSFS toujours en attente');
  }catch(e){
    console.warn('Synchronisation immatriculation MSFS impossible',e);
    // L'absence de retour n'est pas un refus : MSFS peut encore appliquer la
    // nouvelle immatriculation ou rafraîchir la texture après ce délai.
    if(status)status.textContent=`Souhaitée : ${normalized} · confirmation MSFS en attente`;
    return false;
  }
}

function updatePilotRegistrationUI(){
  if(pilot.registration==null)pilot.registration=savedRadioRegistration()||'';
  let wanted=pilotRegistration();
  const d=_lastSimData||{};
  const msfsReg=normalizeFrenchRegistration(d.atc_id)||normalizeFrenchRegistration(d.aircraft_registration);
  adoptMsfsRegistrationIfUnset(msfsReg);
  wanted=pilotRegistration();
  const input=document.getElementById('pilot-reg-input');
  const status=document.getElementById('pilot-reg-status');
  if(input&&document.activeElement!==input)input.value=wanted;
  if(status){
    if(wanted&&msfsReg&&wanted!==msfsReg)status.innerHTML=`<span style="color:var(--yellow);">Souhaitée : ${wanted} · MSFS : ${msfsReg}</span>`;
    else if(wanted&&msfsReg)status.innerHTML=`<span style="color:var(--green);">✓ ${wanted}</span>`;
    else if(msfsReg)status.innerHTML=`<span style="color:var(--green);">✓ ${msfsReg}</span>`;
    else if(wanted)status.innerHTML=`<span style="color:var(--text3);">Souhaitée : ${wanted} · MSFS non confirmé</span>`;
    else status.innerHTML='Immatriculation : non définie';
  }
}

function savePilotRegistration(){
  const input=document.getElementById('pilot-reg-input');
  const reg=normalizeFrenchRegistration(input&&input.value);
  if(!reg){showNotif('Format attendu : F-XXXX');return;}
  pilot.registration=reg;
  try{localStorage.setItem('fvfr_radio_registration',reg);}catch(e){}
  if(input)input.value=reg;
  save();
  updatePilotRegistrationUI();
  updateRadioPanel();
  syncRegistrationToMsfs(reg);
}

function ensureRegistrationSyncedWithMsfs(d=_lastSimData||{}){
  const wanted=pilotRegistration();
  if(!wanted||!hasValidSimData(d))return;
  const msfsReg=normalizeFrenchRegistration(d.atc_id)||normalizeFrenchRegistration(d.aircraft_registration);
  if(msfsReg===wanted){
    _registrationSyncedThisConnection=true;
    return;
  }
  const now=Date.now();
  if(_registrationSyncedThisConnection&&now-_lastRegistrationSyncAttemptAt<30000)return;
  if(now-_lastRegistrationSyncAttemptAt<8000)return;
  _lastRegistrationSyncAttemptAt=now;
  _registrationSyncedThisConnection=true;
  syncRegistrationToMsfs(wanted);
}

function radioRegistrationErrorText(){
  const wanted=pilotRegistration();
  if(wanted)return `Radio bloquée : MSFS ne renvoie pas l’immatriculation avion. Vérifiez que l’avion dans MSFS affiche bien ${wanted}.`;
  return 'Radio bloquée : immatriculation avion non détectée. Renseignez-la dans Pilote au format F-XXXX puis envoyez-la à MSFS.';
}

function ensureFrenchRegistrationForRadio(show=true){
  if(radioCallsign())return true;
  const msg=radioRegistrationErrorText();
  setRadioTranscript(msg);
  if(show){
    showNotif('Immatriculation avion non détectée dans MSFS');
  }
  return false;
}

function radioPhasePhraseText(a,service){
  if(!ensureFrenchRegistrationForRadio(false))return radioRegistrationErrorText();
  const name=a?(a.name||a.icao):'Terrain';
  const icao=a?(a.icao||''):'';
  const label=`${name} ${service&&service.freq?service.freq+' ':''}`.trim();
  const cs=radioCallsign()||'F-XXXX';
  const dest=radioHasMissionContext()?(activeMission.destAP?.icao||activeMission.to||activeMission.poi?.name||'vol local'):'vol local';
  const phase=missionPhase||'waiting';
  const templates=RADIO_PHRASES.phaseMessages||{};
  const ctx={name,airport:icao||name,icao,label,cs,dest};
  const template=templates[phase]||templates.waiting||'';
  const phrase=radioPhraseApplyTemplate(template,ctx);
  const wrapper=templates.wrapper||'{phrase}';
  return radioPhraseApplyTemplate(wrapper,{...ctx,phrase});
}

function radioStationName(a,service){
  if(isSivService(service)){
    const raw=String((service&&service.siv&&(service.siv.info||service.siv.name))||service&&service.desc||'SIV Info').trim();
    return raw.replace(/^SIV\s+/i,'').replace(/\s+Information$/i,' Info').replace(/\s+/g,' ');
  }
  const rawName=String((a&&a.name)||a?.icao||'Terrain');
  const desc=String((service&&service.desc)||'').trim();
  let base='';
  if(desc&&!/^(AFIS|A\/A|AFIS OR A\/A|AUTO INFORMATION)$/i.test(desc)){
    base=desc.replace(/\b(TOWER|TOUR|INFORMATION|INFO|AFIS|GROUND|GND|SOL)\b/ig,'').trim();
  }
  if(!base){
    base=rawName
      .replace(/^A[ée]rodrome\s+d['’]\s*/i,'')
      .replace(/^A[ée]rodrome\s+de\s+/i,'')
      .replace(/^A[ée]roport\s+de\s+/i,'')
      .split(/[–—-]/)[0]
      .trim();
  }
  if((a&&String(a.icao||'').toUpperCase()==='LFDY')||/yvrac/i.test(rawName)||/yvrac/i.test(desc))base='Yvrac';
  else if(/arcachon/i.test(rawName))base='Arcachon';
  else if(/bordeaux/i.test(rawName))base='Bordeaux';
  if(/biscarrosse/i.test(rawName))base='Biscarrosse';
  const type=(service&&service.type)||'auto';
  const label=type==='tower'?'Tour':type==='ground'?'Sol':type==='atis'?'ATIS':type==='afis'||type==='info'||type==='auto'?'Info':(service&&service.label)||'Info';
  return `${base||'Terrain'} ${label}`.replace(/\s+/g,' ').trim();
}

function radioPhraseKey(text){
  let s=String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\balignions\b/gi,'alignons')
    .replace(/\bdecollions\b/gi,'decollons')
    .replace(/\bvend\s+arriere\b/gi,'vent arriere')
    .replace(/\bven\s+arriere\b/gi,'vent arriere')
    .replace(/\bvente\s+arriere\b/gi,'vent arriere')
    .replace(/\bvingt\s+arriere\b/gi,'vent arriere')
    .replace(/\b20\s+arriere\b/gi,'vent arriere')
    .replace(/\bvan\s+arriere\b/gi,'vent arriere')
    .replace(/\bvent\s+a\s+l['’]?\s*arriere\b/gi,'vent arriere')
    .replace(/\bninfo\b/gi,'info')
    .replace(/\bsolde\b/gi,'sol de')
    .replace(/\bF\s*-\s*/gi,'f ')
    .replace(/\b(?:alpha|alfa)\b/gi,'a')
    .replace(/\bbravo\b/gi,'b')
    .replace(/\bcharlie\b/gi,'c')
    .replace(/\bdelta\b/gi,'d')
    .replace(/\becho\b/gi,'e')
    .replace(/\bfox\b/gi,'f')
    .replace(/\bgolf\b/gi,'g')
    .replace(/\bhotel\b/gi,'h')
    .replace(/\bindia\b/gi,'i')
    .replace(/\bjuliet\b/gi,'j')
    .replace(/\bkilo\b/gi,'k')
    .replace(/\blima\b/gi,'l')
    .replace(/\bmike\b/gi,'m')
    .replace(/\bnovember\b/gi,'n')
    .replace(/\boscar\b/gi,'o')
    .replace(/\bpapa\b/gi,'p')
    .replace(/\bquebec\b/gi,'q')
    .replace(/\bromeo\b/gi,'r')
    .replace(/\bsierra\b/gi,'s')
    .replace(/\btango\b/gi,'t')
    .replace(/\buniform\b/gi,'u')
    .replace(/\bvictor\b/gi,'v')
    .replace(/\bwhiskey\b/gi,'w')
    .replace(/\bx ray\b/gi,'x')
    .replace(/\byankee\b/gi,'y')
    .replace(/\bzulu\b/gi,'z')
    .replace(/\bDA40\s*NG\b/gi,'da40 ng')
    .replace(/\bPA\s*-\s*/gi,'pa ')
    .replace(/\bfinal\b/gi,'finale')
    .replace(/\bvertical\b/gi,'verticale')
    .replace(/\bdegage(?:e|es|s)?\b/gi,'degagee')
    .replace(/\bzero\b/gi,'0')
    .replace(/\bunit[eé]s?\b/gi,'1')
    .replace(/\bdeux\b/gi,'2')
    .replace(/\btrois\b/gi,'3')
    .replace(/\bquatre\b/gi,'4')
    .replace(/\bcinq\b/gi,'5')
    .replace(/\bsix\b/gi,'6')
    .replace(/\bsept\b/gi,'7')
    .replace(/\bhuit\b/gi,'8')
    .replace(/\bneuf\b/gi,'9')
    .replace(/\b([0-3]?\d)\s+gauche\b/gi,'$1l')
    .replace(/\b([0-3]?\d)\s+droite\b/gi,'$1r')
    .replace(/\b([0-3]?\d)\s+(?:centre|centrale)\b/gi,'$1c')
    .replace(/\bpoint\b(?!\s*d[\s'’]?attente)/gi,' ')
    // Neutralise les apostrophes (droite ' ou courbe ’) : le bridge Vosk les
    // restitue parfois ("point d'attente"), alors que tous les motsValidation
    // du JSON écrivent ces expressions sans apostrophe ("point d attente").
    // Sans cette normalisation, "point d'attente" ne matche jamais "point d
    // attente" et bloque silencieusement toute phrase qui en dépend.
    .replace(/['’]/g,' ');
  s=normalizePoiText(s);
  s=s.replace(/\b(?:\d+\s+)+\d+\b/g,value=>value.replace(/\s+/g,''));
  s=s.replace(/\s+/g,' ').trim();
  // N'épelle un « bloc » de 2 à 4 lettres/chiffres accolé au « f » que si ce
  // « f » n'est pas lui-même la lettre finale d'un indicatif déjà épelé
  // (ex. « f k f »). Sans ce garde-fou, un mot ordinaire de 2 à 4 lettres
  // suivant immédiatement l'indicatif (ex. « f k f vent arrière ») était
  // lui-même épelé lettre par lettre (« v e n t »), ce qui empêchait ensuite
  // toute reconnaissance de phrases contenant ce mot.
  return s.replace(/(?<![a-z]\s)\bf\s+([a-z0-9]{2,4})\b/g,(m,tail)=>`f ${tail.split('').join(' ')}`);
}

function radioRowSpokenKey(row,idx=0){
  if(row&&typeof row==='object'){
    if(row.id)return `radio-id|${row.id}`;
    return `radio-text|${row.phase||'Radio'}|${radioPhraseKey(row.text||'')}`;
  }
  return radioPhraseKey(row);
}

function currentTowerDepartureOperationKey(){
  const a=currentRadioAirport();
  const service=activeRadioServiceForAirport(a&&a.icao)||radioFallbackServiceForAirport(a);
  if(!a||!service||radioServiceKind(service)!=='tower')return '';
  const rwy=lockedTowerRunway(a,service)||runwayForWind(a,(_lastSimData||{}).wind_direction);
  const runway=String(rwy&&rwy.designator||'').trim();
  if(!runway)return '';
  const missionKey=String(activeMission&&activeMission.id||'libre');
  return [a.icao,service.freq,missionKey,runway].join('|');
}

function towerLineupClearanceActive(){
  const key=currentTowerDepartureOperationKey();
  return !!(key&&_towerLineupIssuedKeys.has(key));
}

function towerTakeoffClearanceActive(){
  const key=currentTowerDepartureOperationKey();
  return !!(key&&_towerTakeoffIssuedKeys.has(key));
}

function radioRowsWithDirective(rows,a,service){
  const kind=radioServiceKind(service);
  let visible=[...(rows||[])];
  if(kind==='siv')visible=visible.filter(row=>!(row&&typeof row==='object'&&row.phase==='Reçu'));
  return visible;
}

function radioRowsWithAllBaseCollations(rows,allRows){
  const visible=[...(rows||[])];

  // Conserve uniquement les collationnements correspondant au sens du vol
  // actuellement affiché. Cela empêche un collationnement d'arrivée AFIS
  // (« rappelons verticale ») de réapparaître pendant un départ.
  const visibleScopes=new Set(
    visible
      .filter(row=>row&&typeof row==='object'&&row.phase==='Collationnement'&&row.flightScope)
      .map(row=>String(row.flightScope))
  );
  const activeScope=visibleScopes.size===1?[...visibleScopes][0]:'';

  (allRows||[])
    .filter(row=>{
      if(!row||typeof row!=='object'||row.phase!=='Collationnement')return false;
      if(!row.flightScope||!activeScope)return true;
      return String(row.flightScope)===activeScope;
    })
    .forEach(row=>{
      const id=radioRowSpokenKey(row);
      if(visible.some(existing=>radioRowSpokenKey(existing)===id))return;
      visible.push(row);
    });

  return visible;
}

function radioKeywordPhraseHit(spoken,key,row){
  const hasAny=(...terms)=>terms.some(term=>spoken.includes(term));
  const hasAll=(...terms)=>terms.every(term=>spoken.includes(term));
  if(row&&Array.isArray(row.motsValidation)&&row.motsValidation.length){
    return row.motsValidation.every(group=>{
      const alternatives=Array.isArray(group)?group:[group];
      return alternatives.some(term=>spoken.includes(radioPhraseKey(term)));
    });
  }
  if(row&&typeof row==='object'&&
    ['request-afis-contact','request-afis-contact-tdp','request-afis-contact-return'].includes(String(row.id||''))){
    return spoken.includes('bonjour');
  }
  if(row&&typeof row==='object'&&row.phase==='Report'){
    const match=key.match(/\bpoint\s+([a-z0-9]{1,12})\b/);
    return !!(match&&spoken.includes('point')&&spoken.replace(/\s+/g,'').includes(match[1]));
  }
  if(row&&typeof row==='object'&&['request-afis-readback','request-afis-readback-tdp'].includes(String(row.id||''))){
    return spoken.includes('point d attente')&&spoken.includes('rappel');
  }
  if(row&&typeof row==='object'&&row.id==='request-siv-quitter-readback'){
    return hasAll('quittons','frequence');
  }
  if(row&&typeof row==='object'&&[
    'request-tour-lineup-readback',
    'request-tour-lineup-readback-tdp',
    'request-tour-lineup-readback-libre'
  ].includes(String(row.id||''))){
    return towerLineupClearanceActive()&&spoken.includes('align')&&spoken.includes('attend')&&spoken.includes('piste');
  }
  if(row&&typeof row==='object'&&['request-tour-takeoff-readback','request-tour-takeoff-readback-tdp'].includes(String(row.id||''))){
    return towerTakeoffClearanceActive()&&spoken.includes('piste')&&hasAny('je decolle','decolle','decollons');
  }
  if(row&&typeof row==='object'&&row.phase==='Collationnement'&&key.includes('point d attente')&&!key.includes('transpondeur')){
    return spoken.includes('point d attente')&&hasAny('rappel','rappelons');
  }
  if(row&&typeof row==='object'&&row.phase==='Collationnement'&&key.includes('transpondeur')){
    const code=(key.match(/\btranspondeur\s+([0-7]{4})\b/)||[])[1];
    return spoken.includes('transpondeur')&&(!code||spoken.replace(/\s+/g,'').includes(code));
  }
  if(row&&typeof row==='object'&&row.phase==='Collationnement'&&key.includes('verticale')){
    return spoken.includes('rappel')&&hasAny('verticale','vertical');
  }
  if(row&&typeof row==='object'&&row.phase==='Collationnement'&&key.includes('qnh')){
    return ['rappel','mainten','roul','piste'].filter(term=>spoken.includes(term)).length>=2;
  }
  if(key.includes('bonjour')){
    const keyWords=key.split(' ').filter(w=>w.length>2&&!['bonjour','info'].includes(w));
    const hasContext=keyWords.some(w=>spoken.includes(w));
    return spoken.includes('bonjour')&&hasContext;
  }
  if(key.includes('parametre')&&key.includes('integration'))return hasAny('parametre','parametres')&&hasAny('integration','integre');
  if(key.includes('integration')||key.includes('integrons')||key.includes('integre'))return hasAny('integration','integre','integrons','integrer');
  if(key.includes('parametre')||key.includes('parametres'))return hasAny('parametre','parametres');
  if(key.includes('demande roulage')||key.includes('demandons le roulage'))return hasAny('roulage','rouler')&&hasAny('parking','depart','destination','vol local');
  if((key.includes('je roule vers')||key.includes('roulons vers')||key.includes('nous roulons au')||key.includes('roulons au'))&&key.includes('point d attente'))return hasAll('roul','point d attente');
  if(key.includes('point d attente')&&key.includes('pret au depart'))return spoken.includes('point d attente')&&hasAny('pret','depart');
  if(key.includes('point d attente')&&['penetre','penetrons'].some(term=>key.includes(term))&&
    ['remonte','remontons'].some(term=>key.includes(term)))return spoken.includes('point d attente')&&hasAny('penetre','penetrons','remonte','remontons');
  if((key.includes('aligne')||key.includes('alignons'))&&key.includes('decollage')){
    return hasAny('aligne','alignons')&&hasAny('pret','decollage');
  }
  if(key.includes('decolle')||key.includes('decollons'))return hasAny('decolle','decollons','decollage');
  if(key.includes('vent arriere'))return spoken.includes('vent arriere');
  if(key.includes('etape de base'))return hasAny('etape de base','base');
  if(key.includes('dernier virage'))return spoken.includes('dernier virage');
  if(key.includes('finale'))return spoken.includes('finale');
  if(key.includes('vitesse maitrisee'))return hasAny('vitesse maitrisee','remonte');
  if(key.includes('piste degagee'))return hasAny('piste degagee','degage');
  if(key.includes('suivi de vol'))return hasAny('suivi de vol','suivi')&&hasAny('trafic','information');
  if(key.includes('information de trafic'))return spoken.includes('trafic');
  if(key.includes('meteo'))return spoken.includes('meteo');
  if(key.includes('transit vfr'))return spoken.includes('transit');
  if(key.includes('changement de cap')||key.includes('changement de niveau'))return hasAny('changement','cap','niveau');
  if(key.includes('autorise decollage'))return hasAll('autorise','decollage');
  if(key.includes('autorise atterrissage'))return hasAll('autorise','atterrissage');
  if(key.includes('contacte')||key.includes('contactons'))return spoken.includes('contact')&&hasAny('tour','sol','siv','mhz');
  if(key.includes('rappelle')||key.includes('rappelons'))return spoken.includes('rappel')&&hasAny('finale','depart','sortie','changement','verticale','quitte','quitter','quittons');
  if(key.includes('en provenance'))return hasAny('provenance','retour');
  if(key.includes('verticale'))return spoken.includes('verticale');
  if(key.includes('integre'))return hasAny('integre','integration');
  if(key.includes('bien recu')||key.includes('information recue'))return hasAny('bien recu','recu','information recue');
  if(key.includes('ecoute')&&!key.includes('j ecoute'))return spoken.includes('ecoute');
  if(key.includes('quitte')||key.includes('quitter')||key.includes('quittons'))return hasAny('quitte','quitter','quittons','au revoir','tout a l heure');
  if(key.includes('parking'))return spoken.includes('parking');
  return false;
}

function radioRunwayForLearning(a,text){
  const s=normalizePoiText(text);
  const m=s.match(/(?:(?:remonte(?:s|z|nt)?|remontons) la|piste)\s+([0-3]?\d)\s*([lrc])?\b/);
  if(m){
    const qfu=`${String(Number(m[1])).padStart(2,'0')}${String(m[2]||'').toUpperCase()}`;
    return {designator:qfu};
  }
  return runwayForWind(a,(_lastSimData||{}).wind_direction);
}

function lockRadioRunwayFromValidatedRow(row){
  if(!row||typeof row!=='object')return;
  const text=String(row.text||'');
  const key=radioPhraseKey(text);
  if(!/(piste|point d attente|parametre|parametres|integration|vent arriere|finale|decol|align)/.test(key))return;
  const a=currentRadioAirport();
  if(!a)return;
  const scope=String(row.flightScope||'')||radioRunwayLockScope(a,_lastSimData||{});
  const parsed=radioRunwayForLearning(a,text);
  const rwy=parsed&&parsed.designator
    ? (radioRunwayByDesignator(a,parsed.designator)||parsed)
    : radioRunwayForContext(a,scope);
  lockRadioRunway(a,rwy,scope);
}

function radioRowPhaseAllowsTranscript(spoken,key,row){
  if(!row||typeof row!=='object')return true;
  if(Array.isArray(row.motsValidation)&&row.motsValidation.length)return true;
  const phase=String(row.phase||'');
  const hasAny=(...terms)=>terms.some(term=>spoken.includes(term));
  const hasAll=(...terms)=>terms.every(term=>spoken.includes(term));
  if(phase==='Contact')return spoken.includes('bonjour');
  if(phase==='Départ'){
    if(key.includes('parametre'))return hasAny('parametre','parametres')&&hasAny('demandons','demande','parking');
    if(key.includes('point d attente')&&key.includes('pret au depart'))return spoken.includes('point d attente')&&hasAny('pret','depart');
    if(key.includes('point d attente')&&hasAny('penetre','penetrons','remonte','remontons'))return spoken.includes('point d attente')&&hasAny('penetre','penetrons','remonte','remontons');
    return true;
  }
  if(phase==='Décollage'){
    if(key.includes('bien recu'))return hasAny('bien recu','recu')&&!hasAny('parametre','point d attente','verticale','finale','parking','quitte');
    return hasAny('decolle','decollons','decollage','aligne');
  }
  if(phase==='Sortie')return hasAny('sortie','quitte','quitter','frequence','tout a l heure','au revoir');
  if(phase==='Arrivée'||phase==='Retour'){
    if(key.includes('bonjour'))return spoken.includes('bonjour');
    if(key.includes('parametre')||key.includes('integration'))return hasAny('parametre','parametres','integration')&&hasAny('provenance','retour','destination','installation','installations');
    return true;
  }
  if(phase==='Intégration')return hasAny('verticale','integration','integre');
  if(phase==='Circuit')return hasAny('vent arriere','etape de base','base','dernier virage');
  if(phase==='Finale')return spoken.includes('finale');
  if(phase==='Atterr.')return hasAny('vitesse maitrisee','remonte');
  if(phase==='Parking')return hasAny('piste degagee','degage','parking');
  if(phase==='Quitter')return hasAny('quitte','quitter','quittons','frequence','au revoir','tout a l heure');
  if(phase==='Collationnement'){
    if(String(row.id||'')==='request-siv-quitter-readback')return hasAll('quittons','frequence');
    if([
      'request-tour-lineup-readback',
      'request-tour-lineup-readback-tdp',
      'request-tour-lineup-readback-libre'
    ].includes(String(row.id||'')))return towerLineupClearanceActive()&&spoken.includes('align')&&spoken.includes('attend')&&spoken.includes('piste');
    if(['request-tour-takeoff-readback','request-tour-takeoff-readback-tdp'].includes(String(row.id||'')))return towerTakeoffClearanceActive()&&spoken.includes('piste')&&hasAny('je decolle','decolle','decollons');
    if(String(row.id||'')==='request-afis-parking-readback'){
      return hasAny('roule','roulons','rouler','roulez')&&spoken.includes('parking')&&
        spoken.includes('rappel');
    }
    return hasAny('transpondeur','roul','rappel','contact','piste','align','attend','decolle','decollons');
  }
  return true;
}
function markRadioPhraseSpoken(text,rows=null,options={}){
  _lastRadioMatchedPhase='';
  _lastRadioMatchedRow=null;
  const spoken=radioPhraseKey(text);
  if(!spoken)return false;
  const candidates=rows||(function(){
    // Priorité au terrain/service figés au moment où le pilote a commencé à
    // parler (_radioSessionAirport/_radioSessionService, voir
    // startRadioListening). Sans ça, si la fréquence change entre le moment
    // où la phrase est prononcée et celui où son transcript est traité, la
    // phrase est comparée aux lignes de la NOUVELLE fréquence au lieu de
    // celle réellement utilisée — ex. une phrase Sol ("...point d'attente...,
    // je rappelle prêt") validée à tort contre la ligne Tour "Départ" dont le
    // motsValidation ["point d attente"] + ["prêt","départ"] matche par
    // recoupement de mots génériques.
    const a=_radioSessionAirport||currentRadioAirport();
    const service=_radioSessionService||activeRadioServiceForAirport(a&&a.icao)||radioFallbackServiceForAirport(a);
    const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
    const kind=radioServiceKind(service);
    const dest=radioHasMissionContext()?(activeMission.destAP?.icao||activeMission.to||activeMission.poi?.name||'vol local'):'vol local';
    const all=radioRequestPresetRows(radioStationName(a,service),cs,dest,service);
    // AA / AFIS : seule la (ou les) ligne(s) du curseur peut être validée.
    if(radioScriptKind(kind))return radioScriptCursorRows(all,a,service);
    let r=all;
    if(kind==='siv'){
      const sivScope=radioActiveContentScope('enroute');
      r=(r||[]).filter(row=>!(row&&typeof row==='object')||!row.flightScope||String(row.flightScope)===sivScope);
    }
    return radioRowsWithAllBaseCollations(radioRowsWithDirective(r,a,service),all);
  })();
  let best=null;
  (candidates||[]).forEach((row,idx)=>{
    const line=typeof row==='object'?row.text:row;
    const key=radioPhraseKey(line);
    const spokenKey=radioRowSpokenKey(row,idx);
    const done=_radioSpokenKeys.has(spokenKey);
    if(!key)return;
    const keyWords=key.split(' ').filter(w=>w.length>1);
    const common=keyWords.filter(w=>spoken.split(' ').includes(w)).length;
    let score=common;
    if(spoken.includes(key)||key.includes(spoken))score+=20;
    ['penetre','remonte','decolle','vent arriere','etape de base','dernier virage','finale','piste degagee','quitte'].forEach(term=>{
      if(spoken.includes(term)&&key.includes(term))score+=8;
      else if(spoken.includes(term)!==key.includes(term))score-=6;
    });
    const keywordHit=radioKeywordPhraseHit(spoken,key,row);
    if(!radioRowPhaseAllowsTranscript(spoken,key,row))return;
    const takeoffMismatch=key.includes('pret au decollage')&&!spoken.includes('aligne')&&!spoken.includes('decollage');
    const hit=!takeoffMismatch&&keywordHit;
    if(hit&&(!best||score>best.score+2||(best.done&&!done&&score>=best.score)))best={idx,key:spokenKey,line,score,done,phase:row&&typeof row==='object'?String(row.phase||''):''};
  });
  if(!best)return false;
  _radioSpokenKeys.add(best.key);
  _lastRadioMatchedPhase=best.phase||'';
  _lastRadioMatchedRow=(candidates||[])[best.idx]||null;
  lockRadioRunwayFromValidatedRow((candidates||[])[best.idx]);
  radioResetCircuitAfterGoAround((candidates||[])[best.idx]);
  updateRadioPanel();
  setRadioTranscript(String(text||''),true);
  return true;
}

function updateAaRadioFlightState(d=_lastSimData||{}){
  if(!hasValidSimData(d))return;
  const onGround=!!d.on_ground;
  const speed=Number(d.speed)||0;
  if(!onGround||speed>45){
    _radioAaWasAirborne=true;
    _radioAaLandedAfterFlight=false;
  }else if(onGround&&_radioAaWasAirborne){
    _radioAaLandedAfterFlight=true;
  }
}

// Remet à zéro le suivi "vient d'atterrir" utilisé pour les demandes radio.
// A appeler quand une mission est validée, abandonnée, ratée (crash) ou
// quand une nouvelle mission est acceptée : sans cela, l'ancien statut
// "de retour" restait mémorisé et les demandes radio affichaient encore
// des phrases de retour alors que le pilote voulait repartir.
// Réinitialise uniquement la progression des phrases déjà prononcées, sans
// toucher au sens de vol ni à la piste verrouillée. À appeler au moment où
// le pilote entre réellement en contact avec une nouvelle station (nouveau
// terrain/service en vol libre), pour que la séquence Contact -> ... reparte
// de zéro plutôt que de sauter les phases déjà cochées lors du départ.
function resetRadioProgressForNewStation(){
  _radioSpokenKeys.clear();
  _lastRadioMatchedPhase='';
}

function resetRadioFlightState(){
  _radioAaWasAirborne=false;
  _radioAaLandedAfterFlight=false;
  _radioFreeFlightDepartureFrequencyLeft=false;
  _radioFreeFlightAwayIcao='';
  _radioFreeFlightMaxDistNm=0;
  _radioMissionDepartureFrequencyLeft=false;
  _radioFreeFlightLastServiceKey='';
  _radioFreeFlightLastServiceKind='';
  _radioFreeFlightLastAirportIcao='';
  _radioSpokenKeys.clear();
  _lastRadioMatchedPhase='';
  _lastRadioReply='';
  _radioReplyServiceKey=null;
  _pendingTransponderReadback=null;
  _sivXpdrCheck=null;
}

// Distance au-delà de laquelle on considère que l'avion a réellement quitté
// le circuit/la verticale du terrain (nettement plus que la largeur d'une
// étape de tour de piste, mais bien en-deçà d'un vol local classique). Sert
// à détecter un retour de vol même quand le pilote reste sur la même
// fréquence AFIS du début à la fin (terrain à fréquence unique), auquel cas
// aucun changement de fréquence ni aucun "je quitte la fréquence" détecté
// côté radio ne permet de savoir qu'un vol a bien eu lieu.
const RADIO_FREE_FLIGHT_AWAY_THRESHOLD_NM=2.5;
// Marge de rapprochement (NM) avant de considérer que l'avion revient vers le
// terrain : tant qu'il s'éloigne, on reste en séquence de départ.
const RADIO_FREE_FLIGHT_RETURN_MARGIN_NM=1.5;

function updateRadioFreeFlightDistanceTracking(a,d){
  if(!a||!a.icao||!hasValidSimData(d))return;
  const icao=String(a.icao||'').toUpperCase();
  if(d.on_ground){
    if(_radioFreeFlightAwayIcao===icao)_radioFreeFlightMaxDistNm=0;
    return;
  }
  const dist=distNM(Number(d.lat),Number(d.lon),Number(a.lat),Number(a.lon));
  if(!Number.isFinite(dist))return;
  if(_radioFreeFlightAwayIcao!==icao){
    _radioFreeFlightAwayIcao=icao;
    _radioFreeFlightMaxDistNm=dist;
  }else if(dist>_radioFreeFlightMaxDistNm){
    _radioFreeFlightMaxDistNm=dist;
  }
  // Une fois réellement éloigné du terrain ET en train de s'en rapprocher, tout
  // contact ultérieur en vol avec ce même terrain est un retour, même sans
  // transition de fréquence détectée entre-temps. Tant que l'avion s'éloigne
  // (sortie de circuit, point de report), la séquence de départ reste affichée :
  // le pilote doit pouvoir annoncer « je quitte la fréquence ».
  if(!radioHasMissionContext()&&_radioFreeFlightMaxDistNm>RADIO_FREE_FLIGHT_AWAY_THRESHOLD_NM&&
     dist<=_radioFreeFlightMaxDistNm-RADIO_FREE_FLIGHT_RETURN_MARGIN_NM){
    if(!_radioFreeFlightDepartureFrequencyLeft)resetRadioProgressForNewStation();
    _radioFreeFlightDepartureFrequencyLeft=true;
  }
}

function updateRadioFreeFlightState(a,d=_lastSimData||{}){
  if(radioHasMissionContext()||!a||!a.icao||!hasValidSimData(d))return;
  updateAaRadioFlightState(d);
  updateRadioFreeFlightDistanceTracking(a,d);
  // Seule une fréquence effectivement réglée et reconnue dans MSFS peut
  // faire évoluer le sens du vol. Une fréquence de secours simplement
  // suggérée par l'interface ne doit jamais déclencher une arrivée.
  const service=activeRadioServiceForAirport(a.icao);
  if(!service)return;
  const kind=radioServiceKind(service);

  // Le SIV reste indépendant du sens départ/retour. Le fait de le contacter
  // en route ne transforme pas le vol en arrivée.
  if(kind==='siv')return;

  const icao=String(a.icao||'').toUpperCase();
  const freq=radioFreqText(service.freq||'');
  const serviceKey=`${kind}|${icao}|${freq}`;
  if(!freq)return;

  if(!_radioFreeFlightLastServiceKey){
    _radioFreeFlightLastServiceKey=serviceKey;
    _radioFreeFlightLastServiceKind=kind;
    _radioFreeFlightLastAirportIcao=icao;
    // Si FlyFranceVFR commence à recevoir un service d'aérodrome alors que
    // l'avion est déjà en vol, il s'agit d'un contact d'arrivée.
    if(!d.on_ground)_radioFreeFlightDepartureFrequencyLeft=true;
    return;
  }

  if(d.on_ground&&!_radioAaLandedAfterFlight){
    // Avant le premier décollage, les changements ATIS -> Sol -> Tour font
    // tous partie de la préparation du départ.
    _radioFreeFlightDepartureFrequencyLeft=false;
    _radioFreeFlightLastServiceKey=serviceKey;
    _radioFreeFlightLastServiceKind=kind;
    _radioFreeFlightLastAirportIcao=icao;
    return;
  }

  if(!d.on_ground&&serviceKey!==_radioFreeFlightLastServiceKey){
    const normalGroundToTowerDeparture=
      _radioFreeFlightLastServiceKind==='ground'&&kind==='tower'&&
      _radioFreeFlightLastAirportIcao===icao;
    if(!normalGroundToTowerDeparture){
      if(!_radioFreeFlightDepartureFrequencyLeft)resetRadioProgressForNewStation();
      _radioFreeFlightDepartureFrequencyLeft=true;
    }
    _radioFreeFlightLastServiceKey=serviceKey;
    _radioFreeFlightLastServiceKind=kind;
    _radioFreeFlightLastAirportIcao=icao;
  }else if(d.on_ground){
    // Après l'atterrissage, un passage Tour -> Sol reste une arrivée, mais la
    // nouvelle fréquence devient la référence pour l'affichage radio.
    _radioFreeFlightLastServiceKey=serviceKey;
    _radioFreeFlightLastServiceKind=kind;
    _radioFreeFlightLastAirportIcao=icao;
  }
}

function radioFreeFlightScope(a=null){
  return _radioFreeFlightDepartureFrequencyLeft?'arrival':'departure';
}

function completeRadioFreeFlightDeparture(text){
  const matchedPhase=String(_lastRadioMatchedPhase||'');
  if(!['Sortie','Quitter'].includes(matchedPhase))return false;
  const spoken=radioPhraseKey(text||'');
  // On attend une annonce de sortie réellement complète : un simple passage
  // en vol, ou le seul mot « quitte », ne change plus la séquence.
  const completedExit=spoken.includes('frequence')&&
    (spoken.includes('quitte')||spoken.includes('quitter')||spoken.includes('quittons'));
  if(!completedExit)return false;

  // En mission, on ne bascule pas _radioFreeFlightDepartureFrequencyLeft
  // (réservé au mode sans mission) mais son équivalent, utilisé pour
  // retenir artificiellement radioMissionFlightScope() en "departure"
  // tant que le pilote n'a pas fini de quitter la fréquence.
  if(radioHasMissionContext()){
    if(_radioMissionDepartureFrequencyLeft)return false;
    _radioMissionDepartureFrequencyLeft=true;
    updateRadioPanel();
    return true;
  }

  if(_radioFreeFlightDepartureFrequencyLeft)return false;
  _radioFreeFlightDepartureFrequencyLeft=true;
  updateRadioPanel();
  return true;
}

// Le sens du vol reste déterminé par les étapes de la mission.
function radioMissionFlightScope(a=null){
  if(radioStandaloneMode||!activeMission)return radioFreeFlightScope(a);
  const radioIcao=String((a&&a.icao)||'').toUpperCase();
  const missionFrom=String(activeMission.from||'').toUpperCase();
  const missionDestination=String(
    (activeMission.destAP&&activeMission.destAP.icao)||activeMission.to||(activeMission.poi&&activeMission.poi.name)||''
  ).toUpperCase();
  const phase=String(missionPhase||activeMission.phase||activeMission.status||'').toLowerCase();
  const missionType=String(activeMission.type||'');

  // Vol aller-retour (Tourist/Circuit, ou mission sans destination distincte) :
  // deux états seulement, "départ" puis "retour" une fois la mission dans sa
  // phase de retour vers la base.
  // Une mission Tours de piste reste dans un scope distinct "local".
  // Elle ne doit donc jamais basculer artificiellement en "departure"/"arrival".
  if(missionType==='TourDePiste')return 'local';

  const isRoundTrip=!missionDestination||missionDestination===missionFrom||
    ['Tourist','Circuit'].includes(missionType);
  const returningToBase=['returning','landing_dest','shutdown','completed','done'].includes(phase);

  // Pour un aller-retour, le passage en "arrival" ne doit pas dépendre
  // uniquement de la progression géographique de la mission (missionPhase) :
  // tant que le pilote n'a pas terminé l'échange radio de sortie de
  // fréquence ("je quitte la fréquence..."), on reste en "departure",
  // sinon les phrases de sortie (phase "Sortie") disparaissent en plein
  // milieu de la séquence si la mission passe en "returning" trop tôt
  // (ex. point d'intérêt survolé rapidement près du terrain de départ).
  if(isRoundTrip)return (returningToBase&&_radioMissionDepartureFrequencyLeft)?'arrival':'departure';

  // Vol aller simple (Pax vers un autre aérodrome) : "départ" jusqu'à l'arrivée
  // sur le terrain de destination, "arrivée" ensuite.
  const atDestination=!!(radioIcao&&missionDestination&&radioIcao===missionDestination);
  return atDestination||returningToBase?'arrival':'departure';
}

function radioPilotRunwayDisplayText(text){
  const sideNames={L:'gauche',R:'droite',C:'centrale'};
  return String(text||'').replace(/\b(\d{1,2})([LRC])\b/gi,(match,number,side)=>
    `${number} ${sideNames[String(side).toUpperCase()]} (${String(side).toUpperCase()})`);
}

// ---------------------------------------------------------------------------
// Curseur de script (AA, AFIS, Tour et Sol, avec et sans mission).
// Le fichier JSON est le script : la prochaine ligne est la première, dans
// l'ordre du fichier, qui n'est pas encore prononcée et dont tous les
// "requires" le sont. Les autres champs ne servent qu'à écarter une ligne :
//   when    : condition de contexte (déjà appliquée dans radioRowsFromExternal)
//   surface : "ground" / "air", la ligne n'est proposée que sur cette surface
//   mutex   : une seule ligne du groupe peut être prononcée ; tant qu'aucune
//             ne l'est, toutes les lignes du groupe sont proposées ensemble
//   hidden  : jamais affichée, ne bloque pas les lignes qui en dépendent
//   groundVariant : "withGround" / "towerAsGround", selon que la Tour agit
//             ou non comme Sol sur ce terrain
// Tour : les clairances d'alignement et de décollage restent émises par les
// minuteurs existants (trafic piste, transpondeur) ; les lignes qui en
// dépendent n'apparaissent qu'une fois la clairance effectivement donnée.
// ---------------------------------------------------------------------------
function radioScriptKind(kind){
  return ['aa','afis','info','tower','ground'].includes(String(kind||''));
}

// Porte d'une ligne dont l'apparition dépend d'une clairance Tour asynchrone.
function radioScriptGateOpen(r,towerActsAsGround=false){
  // Les phrases pilote s'affichent dès la précédente validée (comme l'AFIS et le
  // Sol), sauf les collationnements de clairance Tour : ils n'apparaissent
  // qu'une fois « alignez-vous » / « autorisé décollage » prononcé par la Tour.
  if(towerActsAsGround)return true;
  const id=String(r.id||'');
  if(/^request-tour-lineup-readback/.test(id))return towerLineupClearanceActive();
  if(/^request-tour-takeoff-readback/.test(id))return towerTakeoffClearanceActive();
  return true;
}

function radioScriptAllRows(a,service){
  const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
  const dest=radioHasMissionContext()?(activeMission.destAP?.icao||activeMission.to||activeMission.poi?.name||'vol local'):'vol local';
  return radioRequestPresetRows(radioStationName(a,service),cs,dest,service);
}

function radioScriptCursorRows(allRows,a,service){
  const direction=radioMissionFlightScope(a);
  const contentScope=radioActiveContentScope(direction);
  const towerActsAsGround=radioTowerActsAsGround(a,service);
  // Lignes écartées par la variante Sol / Tour-sans-Sol : un prérequis qui les
  // vise n'a pas de sens dans ce contexte et est considéré comme satisfait.
  const variantExcluded=new Set();
  const script=(allRows||[]).filter(r=>{
    if(!r||typeof r!=='object'||String(r.flightScope||'')!==contentScope)return false;
    // En mode libre/autonome, les scenarios "libre departure"/"libre arrival"
    // ne ressortent que dans le sens de vol correspondant.
    if(radioStandaloneMode&&r.scenarioSub&&String(r.scenarioSub)!==String(direction))return false;
    const excluded=(r.groundVariant==='withGround'&&towerActsAsGround)||
      (r.groundVariant==='towerAsGround'&&!towerActsAsGround);
    if(excluded)variantExcluded.add(String(r.id||''));
    return !excluded;
  });
  const byId=new Map(script.map(r=>[String(r.id||''),r]));
  const spoken=r=>_radioSpokenKeys.has(radioRowSpokenKey(r));
  const doneMutex=new Set(script.filter(r=>r.mutex&&spoken(r)).map(r=>String(r.mutex)));
  const requirementsMet=r=>(Array.isArray(r.requires)?r.requires:[]).every(req=>{
    const id=radioScenarioRequestId(String(req));
    const dep=byId.get(id);
    return _radioSpokenKeys.has(`radio-id|${id}`)||!!(dep&&dep.hidden)||variantExcluded.has(id);
  });
  const eligible=script.filter(r=>!r.hidden&&!spoken(r)&&
    !(r.mutex&&doneMutex.has(String(r.mutex)))&&requirementsMet(r)&&radioScriptGateOpen(r,towerActsAsGround));
  const first=eligible[0];
  if(!first)return [];
  const group=first.mutex?eligible.filter(r=>String(r.mutex)===String(first.mutex)):[first];
  const onGround=!!(_lastSimData&&_lastSimData.on_ground);
  return group.filter(r=>!r.surface||(String(r.surface)==='ground'?onGround:!onGround));
}

const RADIO_SCRIPT_RUNWAY_LOCK_KINDS=['params','integration','verticale','depart','ventarriere','finale','pistedegagee','quitter'];

// Les kinds des fichiers scénarios (params_departure, ventarriere_tdp...) sont
// ramenés aux kinds historiques que connaissent le verrou de piste et les
// effets de bord (squawk, contrôle transpondeur).
function radioScriptEffectKind(kind){
  const k=String(kind||'').replace(/_tdp$/,'');
  if(/^params(_|$)/.test(k))return 'params';
  if(/^clearance-via-tour/.test(k))return 'params';
  if(/^taxiViaTour/.test(k))return 'taxi';
  if(k==='finalecomplet')return 'finale';
  return k;
}

// Réponse liée à la ligne validée (champ "response" du JSON) : elle ne dépend
// plus des mots reconnus dans la phrase du pilote.
async function radioScriptRespond(row,a,service,svcKind){
  if(!row||!radioMissionOrStandaloneActive())return;
  const rowKind=String(row.kind||'');
  const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
  if(svcKind==='tower'&&rowKind==='lineup')return; // clairance d'alignement : scheduleTowerLineupClearance
  if(svcKind==='tower'&&rowKind==='depart'){
    // « aligné, prêt au décollage » : l'autorisation est donnée par le minuteur
    // une fois la piste libre (scheduleTowerTakeoffClearance).
    const towerRwy=lockedTowerRunway(a,service)||runwayForWind(a,(_lastSimData||{}).wind_direction);
    scheduleTowerTakeoffClearance(a,service,cs,towerRwy);
    return;
  }
  if(!row.responseText)return;
  updateRadioPanel();
  if(!ensureFrenchRegistrationForRadio())return;
  const station=radioStationName(a,service);
  const dest=radioHasMissionContext()?(activeMission.destAP?.icao||activeMission.to||activeMission.poi?.name||'vol local'):'vol local';
  const effectKind=radioScriptEffectKind(rowKind);
  const scope=radioRunwayLockScope(a,_lastSimData||{});
  let rwy=radioRunwayForContext(a,scope);
  if(RADIO_SCRIPT_RUNWAY_LOCK_KINDS.includes(effectKind))rwy=lockRadioRunway(a,rwy,scope);
  const holdingPoint=radioHoldingPointText(rwy,a);
  if((svcKind==='tower'||svcKind==='afis'||svcKind==='aa')&&!reportingPointsLoaded)loadReportingPoints();
  if(svcKind==='tower'&&!airspaceData&&typeof ensureAirspaceData==='function'){
    ensureAirspaceData().catch(()=>{});
  }
  // Squawk Sol/Tour, contrôle transpondeur, verrou de piste de départ.
  const phraseCtx=radioPhraseContext(station,cs,dest,service,a,holdingPoint,effectKind);
  if(svcKind==='tower'&&effectKind==='params'&&radioTowerActsAsGround(a,service)){
    // Tour sans Sol : alignement et décollage sont autorisés directement dans
    // la réponse, sans minuteur d'alignement.
    phraseCtx.towerSquawk=assignTowerSquawk(a,service,cs);
    startSivTransponderCheck(phraseCtx.towerSquawk,cs,'tower');
  }else{
    radioApplyResponseSideEffects(effectKind,station,cs,service,a,holdingPoint,phraseCtx);
  }
  // Lignes régénérées après le verrouillage de piste pour que {piste}, {wind},
  // {holdingFull}... soient cohérents avec ce que le pilote vient de dire.
  const fresh=radioRequestPresetRows(station,cs,dest,service,holdingPoint)
    .find(r=>r&&typeof r==='object'&&r.id===row.id);
  const reply=String((fresh&&fresh.responseText)||row.responseText||'').trim();
  if(!reply)return;
  _lastRadioReply=reply;
  const replyEl=document.getElementById('radio-reply');
  if(replyEl)replyEl.textContent=reply;
  radioSpeakSequence([{text:reply,role:radioRoleForServiceKind(svcKind)}]);
}

async function radioScriptHandleTranscript(text,t,svcKind,a,service,isCollation){
  if(!t)return;
  let matched=false;
  if(svcKind==='tower'||svcKind==='afis'){
    // Point de report : reconnaissance tolérante du nom du point, que la
    // simple recherche de mots de la ligne ne couvre pas.
    const point=radioInboundReportingPoint(a);
    const d=_lastSimData||{};
    const nearPoint=!!(point&&Number.isFinite(point.lat)&&Number.isFinite(point.lon)&&
      Number.isFinite(Number(d.lat))&&Number.isFinite(Number(d.lon))&&
      distNM(Number(d.lat),Number(d.lon),point.lat,point.lon)<=1.5);
    // Une intégration semi-directe / directe (étape de base, finale) nomme aussi
    // le point : on laisse alors la validation par mots-clés choisir la bonne ligne.
    const directIntegration=/\b(base|finale|directe?|semi)\b/.test(radioPhraseKey(text));
    if(nearPoint&&!directIntegration&&radioReportingPointMatchesTranscript(text,point)){
      const row=radioScriptCursorRows(radioScriptAllRows(a,service),a,service).find(r=>r.kind==='reportpoint');
      if(row){
        _radioSpokenKeys.add(radioRowSpokenKey(row));
        _lastRadioMatchedPhase=row.phase||'';
        _lastRadioMatchedRow=row;
        matched=true;
        updateRadioPanel();
      }
    }
  }
  if(!matched&&!markRadioPhraseSpoken(text,null,{preserveReply:isCollation}))return;
  // Sortie de fréquence : bascule le sens du vol une fois la phrase complète validée.
  completeRadioFreeFlightDeparture(text);
  if(svcKind==='aa')return;
  await radioScriptRespond(_lastRadioMatchedRow,a,service,svcKind);
}

function radioNextUndoneRow(rows){
  for(let i=0;i<rows.length;i++){
    const x=rows[i];
    if(x&&typeof x==='object'&&x.hidden)continue;
    const key=(x&&typeof x==='object')?radioRowSpokenKey(x,i):radioPhraseKey(x);
    if(!_radioSpokenKeys.has(key))return x;
  }
  return null;
}

function radioPossibleRequestsHtml(a,service){
  if(!radioMissionOrStandaloneActive())return '';
  const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
  const station=radioStationName(a,service);
  const dest=radioHasMissionContext()?(activeMission.destAP?.icao||activeMission.to||activeMission.poi?.name||'vol local'):'vol local';
  const rowHtml=(x,idx=0,keepActive=false)=>{
    if(x&&typeof x==='object'){
      if(x.hidden)return '';
      const color=x.color||'var(--blue)';
      const done=!keepActive&&_radioSpokenKeys.has(radioRowSpokenKey(x,idx));
      const bg=done?'rgba(52,211,153,.14)':'transparent';
      const border=done?'1px solid rgba(52,211,153,.45)':'1px solid transparent';
      const opacity=done?'.68':'1';
      const check=done?' ✓':'';
      const badge=`<span style="display:inline-block;min-width:72px;margin-right:5px;padding:1px 5px;border-radius:4px;background:${done?'rgba(52,211,153,.20)':color+'22'};color:${done?'#34d399':color};font-size:9px;font-weight:700;text-align:center;">${htmlEscape((x.phase||'Radio')+check)}</span>`;
      return `<div style="margin:2px 0 4px;padding:2px 4px;border-radius:5px;background:${bg};border:${border};opacity:${opacity};">${badge}${htmlEscape(radioPilotRunwayDisplayText(x.text||''))}</div>`;
    }
    const done=_radioSpokenKeys.has(radioPhraseKey(x));
    return `<div style="${done?'color:#34d399;opacity:.72;':''}">• ${done?'✓ ':''}${htmlEscape(radioPilotRunwayDisplayText(x))}</div>`;
  };
  if(radioServiceKind(service)==='atis'){
    return '';
  }
  if(isSivService(service)){
    let rows=radioRowsWithDirective(radioRequestPresetRows(station,cs,dest,service),a,service);
    // Le SIV n'a pas de curseur de script : sans ce filtre explicite, les phrases
    // "avec mission" et "sans mission" s'affichent mélangées en permanence.
    const sivScope=radioActiveContentScope('enroute');
    rows=rows.filter(r=>!(r&&typeof r==='object')||!r.flightScope||String(r.flightScope)===sivScope);
    const rowId=r=>(r&&typeof r==='object')?String(r.id||''):'';
    const spokenRow=r=>_radioSpokenKeys.has(radioRowSpokenKey(r));
    const findRow=id=>rows.find(r=>rowId(r)===id);

    // Mission de transit VFR : on garde l'enchaînement séquentiel existant
    // (demande transit -> collationnement) sans y mêler le menu ci-dessous.
    const isTransitFlow=!!findRow('request-siv-transit');

    if(!isTransitFlow){
      const paramsRow=findRow('request-siv-params-readback');
      const quitterRow=findRow('request-siv-quitter');
      const paramsReadbackDone=paramsRow&&spokenRow(paramsRow);
      const quitterAsked=quitterRow&&spokenRow(quitterRow);

      if(quitterAsked){
        // Sortie de fréquence demandée : plus qu'une seule ligne possible,
        // le collationnement final.
        const readbackRow=findRow('request-siv-quitter-readback');
        const only=(readbackRow&&!spokenRow(readbackRow))?[readbackRow]:[];
        return only.map(rowHtml).join('');
      }

      if(paramsReadbackDone){
        // Trafic / météo / sortie de fréquence sont des demandes libres, pas
        // une séquence figée : on les affiche toutes ensemble tant que la
        // sortie n'a pas encore été demandée.
        // Les lignes restent affichées (et redemandables) après prononciation :
        // seule la demande de sortie de fréquence les fait disparaître.
        const menuRows=['request-siv-trafic','request-siv-trafic-vue','request-siv-trafic-negatif','request-siv-meteo','request-siv-quitter']
          .map(findRow)
          .filter(Boolean);
        if(menuRows.length)return menuRows.map(r=>rowHtml(r,0,true)).join('');
      }
    }

    const next=radioNextUndoneRow(rows);
    rows=next?[next]:[];
    return rows.map(rowHtml).join('');
  }
  const allRows=radioRequestPresetRows(station,cs,dest,service);
  // Le curseur du script donne directement la ou les prochaines lignes.
  if(radioScriptKind(radioServiceKind(service)))return radioScriptCursorRows(allRows,a,service).map(rowHtml).join('');
  return '';
}

function radioPersonsOnBoardText(){
  if(radioStandaloneMode)return '1 personne à bord';
  const pax=activeMission&&Number.isFinite(Number(activeMission.pax))?Number(activeMission.pax):0;
  if(!activeMission)return '… personne(s) à bord';
  const total=1+Math.max(0,pax);
  return `${total} personne${total>1?'s':''} à bord`;
}

function radioAircraftTypeText(){
  // Type prononcé : déduit du titre de l'avion détecté par MSFS (aucune table d'avions)
  const title=String((AIRCRAFT[pilot.aircraft]||{}).name||'').replace(/…/g,'').trim();
  if(!title)return 'avion';
  const cessna=title.match(/\bCessna\b.*?\b(\d{3}[A-Z]?)\b/i);
  if(cessna)return 'C'+cessna[1];
  const cleaned=title
    .replace(/\b(Cessna|Robin|Diamond|Piper|Socata|Aquila|JMB|Beechcraft|Beech|Daher|Grob|Pilatus|Aircraft)\b/ig,'')
    .replace(/\b(Asobo|Livery|G1000|NXi|Classic|Standard|Steam|Gauge)\b/ig,'')
    .split('/')[0]
    .replace(/\s+/g,' ')
    .trim();
  return cleaned||'avion léger';
}

function radioDestinationText(){
  if(radioStandaloneMode)return 'pour un vol local';
  if(activeMission&&activeMission.type==='Pax'&&activeMission.destAP){
    const ap=activeMission.destAP;
    const label=(ap.city||ap.name||ap.icao||'destination')
      .replace(/^A[eé]rodrome d['’]\s*/i,'')
      .replace(/^A[eé]roport d['’]\s*/i,'')
      .replace(/\s*\([A-Z]{4}\)\s*$/,'')
      .trim();
    return `pour un vol à destination de ${label}`;
  }
  if(activeMission&&activeMission.type==='TourDePiste')return 'pour des tours de piste';
  if(activeMission)return 'pour un vol local';
  return 'pour un vol local (ou pour un vol à destination de…)';
}

function radioFarewellText(){
  const isTouristRoundTrip=!!(radioHasMissionContext()&&['Tourist','Circuit','TourDePiste'].includes(activeMission.type));
  const isReturnLeg=typeof radioMissionFlightScope==='function'&&radioMissionFlightScope()==='arrival';
  return isTouristRoundTrip&&!isReturnLeg?"à tout à l'heure":'au revoir';
}

function radioAirportNameText(ap){
  return String((ap&&(ap.city||ap.name||ap.icao))||'terrain de départ')
    .replace(/^A[eé]rodrome d['’]\s*/i,'')
    .replace(/^A[eé]roport d['’]\s*/i,'')
    .replace(/\s*\([A-Z]{4}\)\s*$/,'')
    .replace(/\s+/g,' ')
    .trim()||'terrain de départ';
}

function radioInboundOriginText(forAA=false){
  if(radioHasMissionContext()&&activeMission.type==='Pax'){
    const from=airportByIcao(activeMission.from)||selectedAP;
    // A/A : personne à qui s'adresser, donc pas de « vers vos installations ».
    return forAA
      ?`en provenance de ${radioAirportNameText(from)}`
      :`en provenance de ${radioAirportNameText(from)} vers vos installations`;
  }
  return radioHasMissionContext()?'de retour du vol local':'de retour d’un vol local (ou en provenance de…)';
}

function radioInboundPositionText(a,withDirection=false){
  const d=_lastSimData||{};
  if(!a||!hasValidSimData(d))return '';
  const distance=Math.max(1,Math.round(distNM(Number(d.lat),Number(d.lon),Number(a.lat),Number(a.lon))));
  const altitude=Math.max(0,Math.round((Number(d.altitude)||0)/100)*100);
  // Variante A/A : « à 5 nautiques au nord-ouest » (position de l'avion par rapport au terrain).
  const dir=withDirection
    ?` au ${radioCardinalText(radioBearingDeg(Number(a.lat),Number(a.lon),Number(d.lat),Number(d.lon)))}`
    :'';
  return `à ${distance} nautique${distance>1?'s':''}${dir}, altitude ${altitude} pieds`;
}

function radioServiceKind(service){
  if(isSivService(service))return 'siv';
  if(isAirToAirService(service))return 'aa';
  const t=String(service&&service.type||'').toLowerCase();
  if(['atis','ground','tower','afis','info'].includes(t))return t;
  return 'afis';
}

function radioRoleForServiceKind(kind){
  const k=String(kind||'').toLowerCase();
  if(k==='ground')return 'ground';
  if(k==='tower')return 'tower';
  if(k==='afis'||k==='info')return 'afis';
  if(k==='siv')return 'siv';
  if(k==='atis')return 'atis';
  return 'radio';
}

function radioTrafficCallName(station){
  return String(station||'Terrain')
    .replace(/\s+(Info|Information|AFIS|Tour|Sol|ATIS)$/i,'')
    .replace(/\s+/g,' ')
    .trim()||'Terrain';
}

function radioSivDestinationText(){
  if(radioHasMissionContext()&&activeMission.destAP)return radioAirportNameText(activeMission.destAP);
  if(radioHasMissionContext()&&activeMission.to)return String(activeMission.to);
  if(radioHasMissionContext()&&activeMission.poi&&activeMission.poi.name)return String(activeMission.poi.name);
  return 'ma destination';
}

function radioSivQuitContextText(service){
  let destination=radioHasMissionContext()&&activeMission.destAP||null;
  if(!destination&&radioHasMissionContext()&&activeMission.to)destination=airportByIcao(activeMission.to);
  if(!destination&&radioHasMissionContext()&&activeMission.from)destination=airportByIcao(activeMission.from);
  const lat=Number(destination&&destination.lat);
  const lon=Number(destination&&destination.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return 'en sortie de secteur';

  const currentSiv=service&&service.siv
    ? service.siv
    : (hasValidSimData(_lastSimData||{})?getSivAt(Number(_lastSimData.lat),Number(_lastSimData.lon)):null);
  const destinationSiv=getSivAt(lat,lon);
  if(!currentSiv||!destinationSiv)return 'en sortie de secteur';

  const currentName=normalizePoiText(currentSiv.name||currentSiv.info||'');
  const destinationName=normalizePoiText(destinationSiv.name||destinationSiv.info||'');
  const sameSiv=(currentName&&currentName===destinationName)||
    (currentSiv.freq&&destinationSiv.freq&&radioFreqMatches(currentSiv.freq,destinationSiv.freq));
  return sameSiv
    ? `en approche de ${radioAirportNameText(destination)}`
    : 'en sortie de secteur';
}

function radioSivOriginText(){
  const from=radioHasMissionContext()&&activeMission.from?airportByIcao(activeMission.from):null;
  return from?radioAirportNameText(from):radioAirportNameText(selectedAP);
}

function radioCardinalText(deg){
  const names=['nord','nord-est','est','sud-est','sud','sud-ouest','ouest','nord-ouest'];
  return names[Math.round((((deg%360)+360)%360)/45)%8];
}

function radioDeText(name){
  const n=String(name||'').trim();
  if(/^Les\s/i.test(n))return 'des '+n.replace(/^Les\s+/i,'');
  if(/^Le\s/i.test(n))return 'du '+n.replace(/^Le\s+/i,'');
  if(/^[AEIOUYÀÂÉÈÊÎÔÛH]/i.test(n))return 'd\u2019'+n;
  return 'de '+n;
}

function radioSivPositionText(){
  const d=_lastSimData||{};
  const altitude=Math.max(0,Math.round(Number(d.altitude)||0));
  if(!hasValidSimData(d))return `altitude ${altitude} pieds`;
  const lat=Number(d.lat),lon=Number(d.lon);
  const nearest=findNearestAP(lat,lon,40);
  if(!nearest)return `altitude ${altitude} pieds`;
  const distance=Math.round(distNM(lat,lon,nearest.lat,nearest.lon));
  const name=radioAirportNameText(nearest);
  if(distance<1)return `à la verticale ${radioDeText(name)}, altitude ${altitude} pieds`;
  const dir=radioCardinalText(radioBearingDeg(nearest.lat,nearest.lon,lat,lon));
  return `à ${distance} milles nautiques au ${dir} ${radioDeText(name)}, altitude ${altitude} pieds`;
}

function radioSivSquawkText(service){
  const seed=[service&&service.freq,activeMission&&activeMission.from,radioCallsign()||pilotRegistration(),new Date().getUTCDate()].join('|');
  const value=Math.floor(seededRadioRandom(seed)*64);
  return String(6400+Math.floor(value/8)*10+(value%8));
}

function groundSquawkKey(a,cs=radioCallsign()||pilotRegistration()||'F-XXXX'){
  const missionKey=activeMission
    ?String(activeMission.id||[activeMission.type,activeMission.from,activeMission.to,activeMission.title].filter(Boolean).join(':')||'mission')
    :`libre-${new Date().toISOString().slice(0,10)}`;
  return `${String(a&&a.icao||'').toUpperCase()}|${normalizeFrenchRegistration(cs)||String(cs).toUpperCase()}|${missionKey}`;
}

function groundAssignedSquawk(a){
  const key=groundSquawkKey(a);
  return normalizeSquawkCode(_groundSquawkAssignments[key]||(pilot.groundSquawkAssignments&&pilot.groundSquawkAssignments[key]))||'';
}

function assignGroundSquawk(a,service,cs){
  const key=groundSquawkKey(a,cs);
  if(!pilot.groundSquawkAssignments)pilot.groundSquawkAssignments={};
  const saved=_groundSquawkAssignments[key]||pilot.groundSquawkAssignments[key]||'';
  const squawk=normalizeSquawkCode(saved)||radioSivSquawkText(service);
  _groundSquawkAssignments[key]=squawk;
  if(pilot.groundSquawkAssignments[key]!==squawk){
    pilot.groundSquawkAssignments[key]=squawk;
    save();
  }
  return squawk;
}

function towerAssignedSquawk(a){
  const key=groundSquawkKey(a);
  return normalizeSquawkCode(_towerSquawkAssignments[key]||(pilot.towerSquawkAssignments&&pilot.towerSquawkAssignments[key]))||'';
}

function assignTowerSquawk(a,service,cs){
  const key=groundSquawkKey(a,cs);
  if(!pilot.towerSquawkAssignments)pilot.towerSquawkAssignments={};
  const seed=['tower',a&&a.icao,service&&service.freq,key,new Date().getUTCDate()].join('|');
  const value=Math.floor(seededRadioRandom(seed)*64);
  const generated=String(6500+Math.floor(value/8)*10+(value%8));
  const saved=_towerSquawkAssignments[key]||pilot.towerSquawkAssignments[key]||'';
  const squawk=normalizeSquawkCode(saved)||generated;
  _towerSquawkAssignments[key]=squawk;
  if(pilot.towerSquawkAssignments[key]!==squawk){
    pilot.towerSquawkAssignments[key]=squawk;
    save();
  }
  return squawk;
}

function normalizeSquawkCode(value){
  const text=String(value==null?'':value);
  const grouped=text.match(/[0-7]{4}/);
  const raw=grouped?grouped[0]:text.replace(/\D/g,'');
  if(!raw)return '';
  const code=raw.slice(0,4).padStart(4,'0');
  return /^[0-7]{4}$/.test(code)?code:'';
}

function radioTransponderCodeFromTranscript(text){
  const normalized=normalizePoiText(String(text||''));
  const transponderMarker=normalized.indexOf('transpondeur');
  const codeMarker=normalized.indexOf('code');
  const marker=transponderMarker>=0?transponderMarker:codeMarker;
  if(marker<0)return '';
  const digitWords={zero:'0',zéro:'0',un:'1',unite:'1',unité:'1',unités:'1',unites:'1',deux:'2',trois:'3',quatre:'4',cinq:'5',six:'6',sept:'7'};
  const markerWord=transponderMarker>=0?'transpondeur':'code';
  const tokens=normalized.slice(marker+markerWord.length).trim().split(/\s+/);
  let digits='';
  for(const token of tokens){
    if(token==='qnh'||token==='maintenons'||token==='roulons'||token==='rappelons')break;
    const grouped=token.match(/^[0-7]{1,4}/);
    if(grouped)digits+=grouped[0];
    else if(digitWords[token])digits+=digitWords[token];
    if(digits.length>=4)break;
  }
  return digits.length>=4?digits.slice(0,4):'';
}

function radioTransponderDigitsInTranscript(text){
  const raw=String(text||'');
  const numeric=raw.replace(/\D/g,'');
  const digitWords={
    zero:'0',zéro:'0',un:'1',une:'1',unite:'1',unité:'1',unites:'1',unités:'1',
    deux:'2',trois:'3',quatre:'4',cinq:'5',six:'6',sept:'7'
  };
  const spoken=normalizePoiText(raw).split(/\s+/).map(word=>{
    if(/^[0-7]+$/.test(word))return word;
    return digitWords[word]||'';
  }).join('');
  return `${numeric} ${spoken}`;
}

function radioExpectedTransponderCodeForService(a,service,svcKind){
  const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
  if(svcKind==='ground')return assignGroundSquawk(a,service,cs);
  if(svcKind==='tower')return assignTowerSquawk(a,service,cs);
  if(svcKind==='siv')return radioSivSquawkText(service);
  return '';
}

function radioTransponderVoiceRole(source){
  if(source==='ground')return 'ground';
  if(source==='siv')return 'siv';
  if(source==='tower')return 'tower';
  return 'radio';
}

function applyPendingTransponderReadback(check){
  const pending=_pendingTransponderReadback;
  if(!check||!pending||pending.code!==check.code||Date.now()-pending.at>120000)return false;
  check.readbackAt=pending.at;
  check.readbackConfirmed=true;
  _pendingTransponderReadback=null;
  completeTransponderCheckIfReady();
  return true;
}

function startSivTransponderCheck(code,cs,source='siv'){
  const squawk=normalizeSquawkCode(code);
  if(!squawk)return;
  if(_sivXpdrCheck&&_sivXpdrCheck.code===squawk&&_sivXpdrCheck.source===source){
    applyPendingTransponderReadback(_sivXpdrCheck);
    return;
  }
  if(_sivXpdrCheck&&_sivXpdrCheck.reminderTimer)clearTimeout(_sivXpdrCheck.reminderTimer);
  _sivXpdrCheck={code:squawk,cs:radioShortCallsign(cs||radioCallsign()||pilotRegistration()||'F-XXXX'),source,startedAt:Date.now(),readbackAt:0,lastReminderAt:0,confirmed:false,hardwareConfirmed:false,readbackConfirmed:false};
  applyPendingTransponderReadback(_sivXpdrCheck);
}

function radioTransponderReadbackMatches(text,check=_sivXpdrCheck){
  if(!check||!check.code)return false;
  return radioTransponderDigitsInTranscript(text).includes(check.code);
}

function completeTransponderCheckIfReady(){
  const check=_sivXpdrCheck;
  if(!check||check.confirmed||check.announcing||!check.hardwareConfirmed||!check.readbackConfirmed)return false;
  check.announcing=true;
  const msg=radioPhraseApplyTemplate((RADIO_PHRASES.transponderMessages||{}).radarContactReceived||'',{cs:check.cs,shortCs:check.cs});
  _lastRadioReply=msg;
  const reply=document.getElementById('radio-reply');
  if(reply)reply.textContent=msg;
  radioSpeakWhenIdle(msg,radioTransponderVoiceRole(check.source),30000,delivered=>{
    if(_sivXpdrCheck!==check)return;
    check.announcing=false;
    if(delivered){
      check.confirmed=true;
      return;
    }
    setTimeout(()=>completeTransponderCheckIfReady(),1000);
  });
  return true;
}

function towerTrafficMotionState(item,now=Date.now()){
  if(!item)return {age:Infinity,movedRecently:false};
  const lat=Number(item.lat),lon=Number(item.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return {age:Infinity,movedRecently:false};
  const key=String(item.id!=null?item.id:`${lat.toFixed(5)}|${lon.toFixed(5)}`);
  let track=_towerTrafficMovement.get(key);
  if(!track){
    track={lat,lon,firstSeenAt:now,lastMovedAt:now,lastSeenAt:now,hasMoved:false};
    _towerTrafficMovement.set(key,track);
    return {age:0,movedRecently:false};
  }
  if(distNM(track.lat,track.lon,lat,lon)>=0.003){
    track.lat=lat;
    track.lon=lon;
    track.lastMovedAt=now;
    track.hasMoved=true;
  }
  track.lastSeenAt=now;
  return {
    age:now-track.firstSeenAt,
    movedRecently:track.hasMoved&&now-track.lastMovedAt<15000
  };
}

function towerUniqueTrafficItems(traffic){
  const unique=new Map();
  (traffic||[]).forEach(item=>{
    const lat=Number(item&&item.lat),lon=Number(item&&item.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
    const key=`${lat.toFixed(5)}|${lon.toFixed(5)}`;
    const previous=unique.get(key);
    if(!previous){unique.set(key,item);return;}
    const itemGround=item.on_ground===true;
    const previousGround=previous.on_ground===true;
    const itemSpeed=Math.max(0,Number(item.ground_speed)||0);
    const previousSpeed=Math.max(0,Number(previous.ground_speed)||0);
    if((itemGround&&!previousGround)||(itemGround===previousGround&&itemSpeed>previousSpeed))unique.set(key,item);
  });
  return [...unique.values()];
}

function towerRunwayTrafficState(a,rwy,d=_lastSimData||{}){
  const traffic=towerUniqueTrafficItems(Array.isArray(d.traffic)?d.traffic:[]);
  if(!traffic.length||!a||!rwy)return {blocked:false,movingBlocker:false,veryCloseBlocker:false};
  const now=Date.now();
  _towerTrafficMovement.forEach((track,key)=>{
    if(now-track.lastSeenAt>60000)_towerTrafficMovement.delete(key);
  });
  const heading=((Number(rwy.heading)||Number(rwy.r&&rwy.r.trueHeading)||0)%360+360)%360;
  const rad=heading*Math.PI/180;
  const runwayHalfNm=(runwayLength(rwy.r)||800)/3704;
  const userAlt=Number(d.altitude)||0;
  let blocked=false;
  let movingBlocker=false;
  let veryCloseBlocker=false;
  traffic.forEach(item=>{
    const lat=Number(item.lat),lon=Number(item.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
    const distance=distNM(Number(a.lat),Number(a.lon),lat,lon);
    if(distance<0.03||distance>4.5)return;
    const north=(lat-Number(a.lat))*60;
    const east=(lon-Number(a.lon))*60*Math.cos(Number(a.lat)*Math.PI/180);
    const along=north*Math.cos(rad)+east*Math.sin(rad);
    const cross=-north*Math.sin(rad)+east*Math.cos(rad);
    const speed=Math.max(0,Number(item.ground_speed)||0);
    const motion=towerTrafficMotionState(item,now);
    const freshlyObserved=motion.age<15000;
    if(item.on_ground===true){
      const halfWidthM=Math.max(10,(runwayWidth(rwy.r)||30)/2);
      const corridor=(halfWidthM+(speed>3?20:12))/1852;
      const endMargin=speed>3?0.14:0.06;
      const insideRunway=Math.abs(along)<=runwayHalfNm+endMargin&&Math.abs(cross)<=corridor;
      if(!insideRunway)return;
      const credible=speed>3?(freshlyObserved||motion.movedRecently):freshlyObserved;
      if(!credible)return;
      blocked=true;
      if(speed>3&&(freshlyObserved||motion.movedRecently))movingBlocker=true;
      if(Math.abs(along)<=runwayHalfNm+0.08&&Math.abs(cross)<=corridor&&distance<=0.45)veryCloseBlocker=true;
      return;
    }
    if(speed<35)return;
    if(!freshlyObserved&&!motion.movedRecently)return;
    const altitude=Number(item.altitude)||0;
    const headingDelta=Math.abs((((Number(item.heading||0)-heading+540)%360)-180));
    const onFinalAxis=distance<=4&&altitude-userAlt<=1800&&altitude-userAlt>=-100&&
      headingDelta<=30&&Math.abs(cross)<=0.18&&along>=-runwayHalfNm-4&&along<=runwayHalfNm+0.18;
    if(!onFinalAxis)return;
    blocked=true;
    movingBlocker=true;
    if(distance<=1.2&&Math.abs(cross)<=0.12)veryCloseBlocker=true;
  });
  return {blocked,movingBlocker,veryCloseBlocker};
}

function towerHasRunwayTraffic(a,rwy,d=_lastSimData||{}){
  return towerRunwayTrafficState(a,rwy,d).blocked;
}

function scheduleTowerLineupClearance(a,service,cs,rwy){
  const runway=String(rwy&&rwy.designator||'').trim();
  if(!a||!service||!runway)return;
  const missionKey=String(activeMission&&activeMission.id||'libre');
  const key=[a.icao,service.freq,missionKey,runway].join('|');
  if(_towerLineupIssuedKeys.has(key)||_towerLineupPendingKey===key)return;
  if(_towerLineupTimer)clearTimeout(_towerLineupTimer);
  _towerLineupPendingKey=key;
  const delay=18000+Math.floor(seededRadioRandom(`${key}|lineup`)*7000);
  let trafficWaitStartedAt=0;
  let runwayClearSince=0;
  const tryClearance=()=>{
    if(_towerLineupPendingKey!==key)return;
    const currentAirport=currentRadioAirport();
    const currentService=activeRadioServiceForAirport(currentAirport&&currentAirport.icao);
    const sameTower=currentAirport&&String(currentAirport.icao||'')===String(a.icao||'')&&
      currentService&&radioServiceKind(currentService)==='tower'&&radioFreqText(currentService.freq)===radioFreqText(service.freq);
    if(!sameTower||!(_lastSimData&&_lastSimData.on_ground)){
      _towerLineupPendingKey='';
      _towerLineupTimer=null;
      return;
    }
    if(_sivXpdrCheck&&_sivXpdrCheck.source==='tower'&&!_sivXpdrCheck.confirmed){
      trafficWaitStartedAt=0;
      runwayClearSince=0;
      _towerLineupTimer=setTimeout(tryClearance,1000);
      return;
    }
    if(!trafficWaitStartedAt)trafficWaitStartedAt=Date.now();
    const trafficState=towerRunwayTrafficState(a,rwy);
    const failsafeReached=Date.now()-trafficWaitStartedAt>=30000;
    if(trafficState.blocked&&(!failsafeReached||trafficState.veryCloseBlocker)){
      runwayClearSince=0;
      _towerLineupTimer=setTimeout(tryClearance,3000);
      return;
    }
    if(!runwayClearSince){
      runwayClearSince=Date.now();
      _towerLineupTimer=setTimeout(tryClearance,1000);
      return;
    }
    if(Date.now()-runwayClearSince<5000){
      _towerLineupTimer=setTimeout(tryClearance,1000);
      return;
    }
    _towerLineupTimer=null;
    const shortCs=radioShortCallsign(cs||radioCallsign()||pilotRegistration()||'F-XXXX');
    const phraseCtx={
      ...radioPhraseContext(radioStationName(a,service),cs,'',service,a,'','lineup'),
      runway
    };
    const msg=radioPhrasePick('responses','tower',['lineup'],phraseCtx);
    if(!msg){
      _towerLineupTimer=setTimeout(tryClearance,1000);
      return;
    }
    // Comme l'AFIS : le collationnement s'affiche en même temps que la Tour parle.
    _lastRadioReply=msg;
    const reply=document.getElementById('radio-reply');
    if(reply)reply.textContent=msg;
    _towerLineupIssuedKeys.add(key);
    _towerLineupPendingKey='';
    updateRadioPanel();
    radioSpeakWhenIdle(msg,'radio',30000,null);
  };
  _towerLineupTimer=setTimeout(tryClearance,delay);
}

function scheduleTowerTakeoffClearance(a,service,cs,rwy){
  const runway=String(rwy&&rwy.designator||'').trim();
  if(!a||!service||!runway)return;
  const missionKey=String(activeMission&&activeMission.id||'libre');
  const key=[a.icao,service.freq,missionKey,runway].join('|');
  if(_towerTakeoffIssuedKeys.has(key)||_towerTakeoffPendingKey===key)return;
  if(_towerTakeoffTimer)clearTimeout(_towerTakeoffTimer);
  _towerTakeoffPendingKey=key;
  const tryClearance=()=>{
    if(_towerTakeoffPendingKey!==key)return;
    const currentAirport=currentRadioAirport();
    const currentService=activeRadioServiceForAirport(currentAirport&&currentAirport.icao);
    const sameTower=currentAirport&&String(currentAirport.icao||'')===String(a.icao||'')&&
      currentService&&radioServiceKind(currentService)==='tower'&&radioFreqText(currentService.freq)===radioFreqText(service.freq);
    if(!sameTower||!(_lastSimData&&_lastSimData.on_ground)){
      _towerTakeoffPendingKey='';
      _towerTakeoffTimer=null;
      return;
    }
    if(towerHasRunwayTraffic(a,rwy,_lastSimData||{})){
      _towerTakeoffTimer=setTimeout(tryClearance,3000);
      return;
    }
    const phraseCtx=radioPhraseContext(radioStationName(a,service),cs,'',service,a,'','depart');
    const msg=radioPhrasePick('responses','tower',['depart'],phraseCtx);
    if(!msg){
      _towerTakeoffPendingKey='';
      _towerTakeoffTimer=null;
      return;
    }
    _lastRadioReply=msg;
    const reply=document.getElementById('radio-reply');
    if(reply)reply.textContent=msg;
    // Comme l'AFIS : le collationnement s'affiche en même temps que la Tour parle.
    _towerTakeoffIssuedKeys.add(key);
    _towerTakeoffPendingKey='';
    _towerTakeoffTimer=null;
    updateRadioPanel();
    radioSpeakWhenIdle(msg,'tower',30000,null);
  };
  _towerTakeoffTimer=setTimeout(tryClearance,2500);
}

function restoreGroundTransponderCheck(){
  const a=currentRadioAirport();
  const service=activeRadioServiceForAirport(a&&a.icao);
  const activeKind=service?radioServiceKind(service):'';
  if(_sivXpdrCheck&&['ground','tower'].includes(_sivXpdrCheck.source)&&_sivXpdrCheck.source!==activeKind){
      if(_sivXpdrCheck.reminderTimer)clearTimeout(_sivXpdrCheck.reminderTimer);
      _sivXpdrCheck=null;
  }
  if(!['ground','tower'].includes(activeKind))return;
  const squawk=activeKind==='ground'?groundAssignedSquawk(a):towerAssignedSquawk(a);
  if(!squawk)return;
  if(!_sivXpdrCheck||_sivXpdrCheck.source!==activeKind||_sivXpdrCheck.code!==squawk){
    startSivTransponderCheck(squawk,radioCallsign()||pilotRegistration()||'F-XXXX',activeKind);
  }
}

function updateSivTransponderCheck(d=_lastSimData||{}){
  restoreGroundTransponderCheck();
  if(!_sivXpdrCheck||_sivXpdrCheck.confirmed)return;
  const live=normalizeSquawkCode(d.transponder_code||d.xpdr_code||d.squawk);
  const xpdrState=Number(d.transponder_state);
  const altActive=d.transponder_alt===true||xpdrState===4;
  const codeMatches=!!live&&live===_sivXpdrCheck.code;
  const now=Date.now();
  if(codeMatches&&altActive){
    if(_sivXpdrCheck.reminderTimer){
      clearTimeout(_sivXpdrCheck.reminderTimer);
      _sivXpdrCheck.reminderTimer=null;
    }
    _sivXpdrCheck.hardwareConfirmed=true;
    completeTransponderCheckIfReady();
    return;
  }
  _sivXpdrCheck.hardwareConfirmed=false;
  if(_sivXpdrCheck.readbackConfirmed&&_sivXpdrCheck.readbackAt>0&&
    now-_sivXpdrCheck.readbackAt>=15000&&now-(_sivXpdrCheck.lastReminderAt||0)>=30000){
    const check=_sivXpdrCheck;
    check.lastReminderAt=now;
    check.reminderTimer=setTimeout(()=>{
      if(_sivXpdrCheck!==check||check.confirmed||!check.readbackConfirmed)return;
      check.reminderTimer=null;
      const latest=_lastSimData||{};
      const latestCode=normalizeSquawkCode(latest.transponder_code||latest.xpdr_code||latest.squawk);
      const latestState=Number(latest.transponder_state);
      const latestAlt=latest.transponder_alt===true||latestState===4;
      if(latestCode===check.code&&latestAlt){
        updateSivTransponderCheck(latest);
        return;
      }
      const msg=radioPhraseApplyTemplate((RADIO_PHRASES.transponderMessages||{}).radarContactMissing||'',{cs:check.cs,shortCs:check.cs,code:check.code});
      _lastRadioReply=msg;
      const reply=document.getElementById('radio-reply');
      if(reply)reply.textContent=msg;
      // Ce rappel conserve son délai historique. S'il arrive pendant une
      // phrase, il attend sa fin puis laisse trois secondes avant de parler.
      radioSpeakWhenIdle(msg,radioTransponderVoiceRole(check.source),30000,null,RADIO_REMINDER_GAP_MS);
    },2000);
  }
}

function radioTowerActsAsGround(a,service){
  return radioServiceKind(service)==='tower'&&
    !radioServicesForAirport(a&&a.icao).some(s=>radioServiceKind(s)==='ground');
}

function radioLocalTdpRequestId(serviceKind,kind){
  if(!(radioHasMissionContext()&&activeMission.type==='TourDePiste'))return '';
  const map={
    afis:{
      ventarriere:'request-afis-downwind-tdp',
      base:'request-afis-base-tdp',
      finale:'request-afis-final-tdp',
      finalecomplet:'request-afis-final-tdp-complet',
      pistedegagee:'request-afis-parking-tdp',
      quitter:'request-afis-leave-tdp'
    },
    tower:{
      ventarriere:'request-tour-downwind-tdp',
      base:'request-tour-base-tdp',
      finale:'request-tour-final-tdp',
      finalecomplet:'request-tour-final-tdp-complet',
      pistedegagee:'request-tour-parking-tdp',
      quitter:'request-tour-leave-tdp'
    },
    aa:{ventarriere:'request-aa-downwind-tdp',finale:'request-aa-final-tdp',finalecomplet:'request-aa-final-tdp-complet'},
  };
  return map[serviceKind]&&map[serviceKind][kind]||'';
}

function radioLocalTdpResponseKey(serviceKind,kind){
  if(!(radioHasMissionContext()&&activeMission.type==='TourDePiste'))return '';
  const map={
    ground:{params:'sol_taxi_tdp',depart:'sol_depart_tdp'},
    afis:{
      depart:'depart-tdp',
      ventarriere:'afis_ventarriere_tdp',
      base:'afis_base_tdp',
      finale:'afis_finale_tdp',
      finalecomplet:'afis_finale_tdp_complet',
      pistedegagee:'afis_pistedegagee_tdp',
      quitter:'afis_quitter_tdp'
    },
    tower:{
      ventarriere:'ventarriere_tdp',
      base:'base_tdp',
      finale:'finale_tdp',
      // 'complet' réutilise la même clé "finale" que le scénario d'arrivée
      // classique (texte identique dans le JSON, fusionné sur les deux
      // portées de vol), car l'autorisation d'atterrissage est la même.
      finalecomplet:'finale',
      pistedegagee:'pistedegagee',
      quitter:'quitter',
      taxi:'taxiViaTourTdp'
    },
  };
  return map[serviceKind]&&map[serviceKind][kind]||'';
}

// Boucle "tours de piste" : deux options exclusives apparaissent en même
// temps en phase Finale (touché-décollé pour relancer un tour, ou complet
// pour terminer la mission). Une fois l'une des deux prononcée, l'autre
// disparaît jusqu'à ce que le touché-décollé effectif (détecté via la
// télémétrie sol/vol) relance un nouveau tour et réinitialise les deux.
const RADIO_TDP_LOOP_REQUEST_IDS=[
  'request-aa-downwind-tdp','request-aa-base-tdp','request-aa-final-tdp','request-aa-final-tdp-complet',
  'request-afis-downwind-tdp','request-afis-base-tdp','request-afis-final-tdp','request-afis-final-tdp-complet',
  'request-tour-downwind-tdp','request-tour-base-tdp','request-tour-final-tdp','request-tour-final-tdp-complet'
];
const RADIO_TDP_FINALE_TOUCHANDGO_IDS=['request-aa-final-tdp','request-afis-final-tdp','request-tour-final-tdp'];
const RADIO_TDP_FINALE_COMPLET_IDS=['request-aa-final-tdp-complet','request-afis-final-tdp-complet','request-tour-final-tdp-complet'];

// Remise de gaz : on efface vent arrière / base / finale / remise de gaz du
// service concerné pour que le circuit puisse être refait.
function radioResetCircuitAfterGoAround(row){
  const m=String(row&&row.id||'').match(/^request-(aa|afis|tour)-goaround/);
  if(!m)return;
  const prefix=`radio-id|request-${m[1]}-`;
  [..._radioSpokenKeys].forEach(k=>{
    if(k.startsWith(prefix)&&/^(downwind|base|final|goaround)/.test(k.slice(prefix.length)))_radioSpokenKeys.delete(k);
  });
  // Intégration semi-directe ou directe : le collationnement « intégrez /
  // rappelez en vent arrière » n'a jamais été prononcé, donc la ligne vent
  // arrière ne redeviendrait jamais éligible (prérequis manquant) et le
  // curseur repartirait sur « finale ». On considère l'entrée en circuit
  // comme déjà donnée pour que le circuit reparte bien sur « vent arrière ».
  if(m[1]==='afis'){
    ['request-afis-integration-readback','request-afis-report-readback-libre'].forEach(id=>_radioSpokenKeys.add(`radio-id|${id}`));
  }else if(m[1]==='aa'){
    ['request-aa-integration','request-aa-integration-libre'].forEach(id=>_radioSpokenKeys.add(`radio-id|${id}`));
  }
}

function resetTdpCircuitProgress(){
  RADIO_TDP_LOOP_REQUEST_IDS.forEach(id=>_radioSpokenKeys.delete(`radio-id|${id}`));
  updateRadioPanel();
}

let _tdpGroundTouchSeen=false;

// Détecte un touché-décollé effectif (contact avec la piste puis nouveau
// décollage) pendant une mission Tours de piste, une fois l'annonce
// "pour un touché-décollé" faite, afin de relancer un nouveau tour
// (vent arrière -> étape de base -> finale) plutôt que de rester bloqué
// sur la dernière demande prononcée.
function updateTdpLoopState(d=_lastSimData||{}){
  if(!hasValidSimData(d)){return;}
  if(!(radioHasMissionContext()&&activeMission.type==='TourDePiste')){
    _tdpGroundTouchSeen=false;
    return;
  }
  const touchAndGoAnnounced=RADIO_TDP_FINALE_TOUCHANDGO_IDS.some(id=>_radioSpokenKeys.has(`radio-id|${id}`));
  const completAnnounced=RADIO_TDP_FINALE_COMPLET_IDS.some(id=>_radioSpokenKeys.has(`radio-id|${id}`));
  // Si le pilote a choisi de terminer (complet), ou si aucun touché-décollé
  // n'a encore été annoncé sur ce tour, rien à surveiller.
  if(!touchAndGoAnnounced||completAnnounced){
    _tdpGroundTouchSeen=false;
    return;
  }
  const onGround=!!d.on_ground;
  if(onGround){
    // Tout contact avec le sol compte, même bref ou brutal (rebond) : pas de
    // seuil de vitesse, qui peut ne jamais être atteint - ou être franchi
    // entre deux rafraîchissements - lors d'un toucher dur ou irrégulier.
    _tdpGroundTouchSeen=true;
  }else if(_tdpGroundTouchSeen){
    // De nouveau en vol après ce contact avec la piste : le touché-décollé
    // est terminé, on relance un tour de piste complet.
    resetTdpCircuitProgress();
    _tdpGroundTouchSeen=false;
  }
}

function radioRequestPresetRows(station,cs,dest,service,holdingPointOverride=''){
  const a=currentRadioAirport();
  const kind=radioServiceKind(service);
  const ctx=radioPhraseContext(station,cs,dest,service,a,holdingPointOverride,kind);
  const externalRows=radioRowsFromExternal(kind,ctx);
  if(externalRows)return externalRows;
  console.warn(`[Radio] Aucune phrase définie dans radio/phrases.json pour le service ${kind||'inconnu'}.`);
  return [];
}

function radioWindBriefText(){
  const d=_lastSimData||{};
  const windDir=((Math.round(Number(d.wind_direction)||0)%360)+360)%360;
  const windSpeed=Math.round(Number(d.wind_speed)||0);
  const fragments=RADIO_PHRASES.fragments||{};
  const template=windSpeed>0?fragments.wind:fragments.windCalm;
  return radioPhraseApplyTemplate(template||'',{
    windDir:String(windDir).padStart(3,'0'),
    windSpeed:String(windSpeed)
  });
}

function seededRadioRandom(seed){
  let h=2166136261;
  String(seed||'').split('').forEach(ch=>{h^=ch.charCodeAt(0);h=Math.imul(h,16777619);});
  return ((h>>>0)%100000)/100000;
}

function radioClockBearingText(relativeDeg){
  const hour=Math.max(1,Math.min(12,Math.round((((relativeDeg%360)+360)%360)/30)||12));
  const words=(RADIO_PHRASES.fragments&&RADIO_PHRASES.fragments.clockHours)||{};
  return words[String(hour)]||radioPhraseApplyTemplate((RADIO_PHRASES.fragments||{}).clockFallback||'{hour} heures',{hour});
}

function radioBearingDeg(lat1,lon1,lat2,lon2){
  const toRad=v=>Number(v)*Math.PI/180;
  const y=Math.sin(toRad(lon2-lon1))*Math.cos(toRad(lat2));
  const x=Math.cos(toRad(lat1))*Math.sin(toRad(lat2))-
    Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}

function radioSivTrafficText(service,opts={}){
  const d=_lastSimData||{};
  const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
  const shortCs=radioShortCallsign(cs);
  const messages=RADIO_PHRASES.trafficMessages||{};
  if(!hasValidSimData(d))return opts.detail?null:radioPhraseApplyTemplate(messages.unavailable||'',{cs,shortCs});
  const ownLat=Number(d.lat),ownLon=Number(d.lon),ownAlt=Number(d.altitude)||0,ownHeading=Number(d.heading)||0;
  // Avions IA crees par l'application : immatriculation et modele reconnus.
  const aiObjects=(typeof _aiTrafficObjects!=='undefined'&&Array.isArray(_aiTrafficObjects))?_aiTrafficObjects:[];
  const traffic=(Array.isArray(d.traffic)?d.traffic:[])
    .map(item=>{
      const lat=Number(item&&item.lat),lon=Number(item&&item.lon);
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
      // 0.02 nm minimum : sur les petits terrains les avions IA sont
      // stationnes a quelques dizaines de metres du pilote.
      const dist=distNM(ownLat,ownLon,lat,lon);
      if(!Number.isFinite(dist)||dist<0.02||dist>(opts.maxDist||12))return null;
      if(opts.airborneOnly&&item.on_ground)return null;
      const alt=Number(item.altitude||item.altitude_ft||item.alt)||ownAlt;
      if(opts.maxAltDelta!=null&&Math.abs(alt-ownAlt)>opts.maxAltDelta)return null;
      const bearing=radioBearingDeg(ownLat,ownLon,lat,lon);
      const rel=(bearing-ownHeading+360)%360;
      const ai=aiObjects.find(x=>Number(x.object_id)===Number(item.id))||null;
      return {item,dist,rel,altDelta:alt-ownAlt,ai};
    })
    .filter(Boolean)
    .sort((a,b)=>a.dist-b.dist);
  if(!traffic.length)return opts.detail?null:radioPhraseApplyTemplate(messages.noneKnown||'',{cs,shortCs});
  const nearest=traffic[0];
  const clock=radioClockBearingText(nearest.rel);
  const dist=Math.max(1,Math.round(nearest.dist));
  let altText;
  if(nearest.item&&nearest.item.on_ground)altText=messages.onGround||'au sol';
  else{
    const altDelta=Math.round(nearest.altDelta/100)*100;
    const altitudeKey=Math.abs(altDelta)<150?'sameAltitude':altDelta>0?'above':'below';
    altText=radioPhraseApplyTemplate(messages[altitudeKey]||'',{altitude:String(Math.abs(altDelta))});
  }
  let type=messages.aircraftLight||'';
  const modelOf=title=>/DR400/i.test(title)?(messages.aircraftDr400||'un DR400'):(/DA40/i.test(title)?(messages.aircraftDa40ng||'un DA40 NG'):(/172/i.test(title)?'un Cessna 172':(messages.aircraftLight||'')));
  if(nearest.ai){
    // Trafic IA de l'application : modele reel + immatriculation annoncee.
    type=(modelOf(String(nearest.ai.model||nearest.ai.title||''))+' '+String(nearest.ai.tail_number||'')).trim();
  }else{
    type=modelOf(String((nearest.item&&nearest.item.title)||''));
  }
  let dir='';
  const itemHeading=Number(nearest.item&&nearest.item.heading);
  if(Number.isFinite(itemHeading)){
    const hdiff=Math.abs((((itemHeading-ownHeading+540)%360)-180));
    dir=hdiff<=60?(messages.sameDirection||''):hdiff>=120?(messages.oppositeDirection||''):'';
  }
  const reportText=radioPhraseApplyTemplate(messages.report||'',{
    cs,shortCs,type,clock,dist:String(dist),altitudeText:altText,direction:dir
  }).replace(/\s+,/g,',').replace(/\s+\./g,'.');
  return opts.detail?{text:reportText,id:String(nearest.item&&nearest.item.id!=null?nearest.item.id:'?'),dist:nearest.dist}:reportText;
}

// Alerte de proximité : comme en vrai, le SIV / l'AFIS / la Tour signale un avion proche
// sans que le pilote ait à demander le trafic (avion en vol à moins de 3 NM et 1 500 ft).
const _trafficAlertSeen=new Map();
let _lastTrafficAlertAt=0;
function updateTrafficProximityAlert(d=_lastSimData||{}){
  const now=Date.now();
  if(!radioMissionOrStandaloneActive()||!hasValidSimData(d)||d.on_ground)return;
  if(now-_lastTrafficAlertAt<20000||!radioCallsign())return;
  const a=currentRadioAirport();
  const service=activeRadioServiceForAirport(a&&a.icao)||radioFallbackServiceForAirport(a);
  const kind=service?radioServiceKind(service):'';
  if(!['siv','afis','info','tower'].includes(kind))return;
  _trafficAlertSeen.forEach((t,id)=>{if(now-t>120000)_trafficAlertSeen.delete(id);});
  const hit=radioSivTrafficText(service,{detail:true,airborneOnly:true,maxDist:3,maxAltDelta:1500});
  if(!hit||_trafficAlertSeen.has(hit.id))return;
  _trafficAlertSeen.set(hit.id,now);
  _lastTrafficAlertAt=now;
  const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
  const shortCs=radioShortCallsign(cs);
  const template=(RADIO_PHRASES.alerts||{}).trafficProximity||'Attention, {trafficInfo}';
  const msg=radioPhraseApplyTemplate(template,{cs,shortCs,trafficInfo:hit.text});
  // Le pilote peut ensuite répondre « trafic en vue » ou « négatif contact » (menu SIV)
  if(kind==='siv'){_radioSpokenKeys.add('radio-id|request-siv-trafic');updateRadioPanel();}
  radioSpeakSequence([{text:msg,role:radioRoleForServiceKind(kind)}]);
}
// Surveillance autonome (aucun branchement ailleurs que dans ce fichier radio)
setInterval(()=>{try{updateTrafficProximityAlert();}catch(e){console.warn('Alerte trafic',e);}},2000);

function radioQnhText(d){
  const qnh=Number(d&&d.qnh_hpa);
  const value=Number.isFinite(qnh)&&qnh>=850&&qnh<=1100?Math.round(qnh):1013;
  return radioPhraseApplyTemplate((RADIO_PHRASES.fragments||{}).qnh||'QNH {qnh}',{qnh:String(value)});
}

// ============ Base statique des points d'attente (fichier points_attente.json, enrichi manuellement carte par carte) ============
// Regenere ce bloc avec le script de conversion a chaque mise a jour de points_attente.json.
// ============ Base des points d'attente (chargee depuis radio/points_attente.json, comme phrases.json) ============
let HOLDING_POINTS_DB={};
let _holdingPointsDbLoaded=false;

async function loadHoldingPointsDb(){
  try{
    const resp=await fetch('radio/points_attente.json',{cache:'no-store'});
    if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
    const data=await resp.json();
    const db={};
    (data&&data.aerodromes||[]).forEach(aero=>{
      const icao=String(aero&&aero.icao||'').toUpperCase();
      if(!icao)return;
      const entry={};
      (aero.runways||[]).forEach(r=>{
        const qfu=String(r&&r.qfu||'').trim().toUpperCase();
        const name=String((r&&r.points&&r.points.name)||'').trim().toUpperCase();
        if(qfu&&name)entry[qfu]=name;
      });
      if(Object.keys(entry).length)db[icao]=entry;
    });
    HOLDING_POINTS_DB=db;
    _holdingPointsDbLoaded=true;
    console.log('[Radio] Points d\'attente charges',Object.keys(db).length,'aerodrome(s)');
  }catch(e){
    _holdingPointsDbLoaded=false;
    console.warn('[Radio] points_attente.json indisponible, aucun point d\'attente connu',e);
  }
}

function radioHoldingPointText(rwy,a=currentRadioAirport()){
  const icao=String(a&&a.icao||'').toUpperCase();
  const qfu=String(rwy&&rwy.designator||'').toUpperCase();
  const label=HOLDING_POINTS_DB[icao]&&HOLDING_POINTS_DB[icao][qfu];
  if(label)return `point d'attente ${label} piste ${qfu}`;
  const fragments=RADIO_PHRASES.fragments||{};
  return rwy&&rwy.designator
    ?radioPhraseApplyTemplate(fragments.holdingRunway||'',{runway:rwy.designator})
    :(fragments.holdingActiveRunway||'');
}


function radioApplyResponseSideEffects(kind,station,cs,service,a,holdingPointOverride='',ctx={}){
  if(!service||isAirToAirService(service))return '';
  const d=_lastSimData||{};
  const kindSvc=radioServiceKind(service);
  if(kindSvc==='atis')return '';
  const scope=radioRunwayLockScope(a,d);
  let rwy=radioRunwayForContext(a,scope);
  const inboundTower=kindSvc==='tower'&&radioIsInboundToAirport(a,d);
  if(['params','integration','verticale','depart'].includes(String(kind||''))){
    rwy=lockRadioRunway(a,rwy,scope);
    if(kindSvc==='ground'){
      const towerService=radioServicesForAirport(a&&a.icao).find(s=>radioServiceKind(s)==='tower');
      if(towerService)lockRadioRunway(a,rwy,'departure');
    }
  }
  if(kind==='params'){
    if(kindSvc==='ground'){
      ctx.groundSquawk=assignGroundSquawk(a,service,cs);
      startSivTransponderCheck(ctx.groundSquawk,cs,'ground');
    }else if(kindSvc==='tower'){
      ctx.towerSquawk=assignTowerSquawk(a,service,cs);
      startSivTransponderCheck(ctx.towerSquawk,cs,'tower');
      if(!inboundTower)scheduleTowerLineupClearance(a,service,cs,rwy);
    }else if(kindSvc==='siv'){
      startSivTransponderCheck(ctx.sivSquawk,cs);
    }
  }
  return '';
}

async function radioRequestPreset(kind,options={}){
  if(!radioMissionOrStandaloneActive())return;
  const speakRequest=options.speakRequest!==false;
  updateRadioPanel();
  if(!ensureFrenchRegistrationForRadio())return;
  const a=currentRadioAirport();
  const service=activeRadioServiceForAirport(a&&a.icao)||radioFallbackServiceForAirport(a);
  if(radioServiceKind(service)!=='atis'&&_activeAtisBroadcastKey)stopAutomaticAtis();
  const station=radioStationName(a,service);
  const cs=radioCallsign()||pilotRegistration()||'F-XXXX';
  const dest=radioHasMissionContext()?(activeMission.destAP?.icao||activeMission.to||activeMission.poi?.name||'vol local'):'vol local';
  const scope=radioRunwayLockScope(a,_lastSimData||{});
  let rwy=radioRunwayForContext(a,scope);
  if(['params','integration','verticale','depart','ventarriere','finale','pistedegagee','quitter'].includes(String(kind||''))){
    rwy=lockRadioRunway(a,rwy,scope);
  }
  const holdingPoint=radioHoldingPointText(rwy,a);
  const svcKind=radioServiceKind(service);
  // Idem pour les points de report : chargement en arrière-plan, ne bloque
  // jamais l'échange radio avec la Tour.
  if((svcKind==='tower'||svcKind==='afis'||svcKind==='aa')&&!reportingPointsLoaded)loadReportingPoints();
  // Ne jamais bloquer la réponse radio sur le chargement de l'espace aérien :
  // ce chargement peut être long (fetch réseau en cascade, jusqu'à une source
  // externe) et ne sert qu'à enrichir la clairance CTR (facultatif). On le
  // lance en arrière-plan et on continue immédiatement.
  if(svcKind==='tower'&&!airspaceData&&typeof ensureAirspaceData==='function'){
    ensureAirspaceData().catch(()=>{});
  }
  const rows=radioRequestPresetRows(station,cs,dest,service,holdingPoint);
  if(svcKind==='aa'&&options.speakRequest===false){
    setRadioTranscript('Annonce auto-information enregistrée. Aucune réponse attendue en A/A.');
    return;
  }
  const indexMaps={
    aa:{params:0,depart:1,ventarriere:2,finale:3,pistedegagee:4,quitter:5,bonjour:0},
    atis:{params:0,readback:1,bonjour:0},
    ground:{bonjour:0,params:1,readback:2,depart:3},
    tower:radioIsInboundToAirport(a)
      ? {bonjour:0,params:1,readback:2,reportpoint:3,depart:3,ventarriere:4,base:4,finale:5,pistedegagee:6,quitter:7,taxi:1}
      : {bonjour:0,params:1,readback:2,reportpoint:4,depart:4,ventarriere:5,base:5,finale:6,pistedegagee:7,quitter:8,taxi:1},
    siv:{bonjour:0,params:1,readback:2,trafic:3,meteo:4,depart:5,change:6,quitter:7,traficvue:3,traficnegatif:3},
    afis:{bonjour:0,params:1,readback:2,depart:3,sortie:5,integration:7,verticale:9,ventarriere:10,base:10,finale:11,pistedegagee:12,quitter:13},
    // Un service affiché « Info » utilise exactement les phrases AFIS.
    info:{bonjour:0,params:1,readback:2,depart:3,sortie:5,integration:7,verticale:9,ventarriere:10,base:10,finale:11,pistedegagee:12,quitter:13}
  };
  const idx=(indexMaps[svcKind]||indexMaps.afis)[kind]??0;
  const sivRequestIds={
    bonjour:'request-siv-contact',
    params:'request-siv-suivi',
    readback:'request-siv-params-readback',
    trafic:'request-siv-trafic',
    traficvue:'request-siv-trafic-vue',
    traficnegatif:'request-siv-trafic-negatif',
    meteo:'request-siv-meteo',
    depart:'request-siv-transit',
    change:'request-siv-change',
    quitter:'request-siv-quitter'
  };
  const localTdpRequestId=radioLocalTdpRequestId(svcKind,kind);
  const request=svcKind==='siv'
    ? (rows.find(row=>row&&row.id===sivRequestIds[kind])||rows[idx]||rows[0])
    : (localTdpRequestId
        ? (rows.find(row=>row&&row.id===localTdpRequestId)||rows[idx]||rows[0])
        : (rows[idx]||rows[0]));
  const requestText=request&&typeof request==='object'?request.text:request;
  if(request){
    _radioSpokenKeys.add(radioRowSpokenKey(request,idx));
    updateRadioPanel();
  }
  const phraseCtx=radioPhraseContext(station,cs,dest,service,a,holdingPoint,kind);
  phraseCtx.trafficInfo=svcKind==='siv'?radioSivTrafficText(service):'';
  radioApplyResponseSideEffects(kind,station,cs,service,a,holdingPoint,phraseCtx);
  let responseKey=kind;
  if(svcKind==='tower'&&kind==='params'){
    if(radioIsInboundToAirport(a)){
      responseKey='params_inbound';
    }else if(radioTowerActsAsGround(a,service)){
      // Tour agissant comme Sol : pas de "maintenez point d'attente"
      // intermédiaire, la clairance d'alignement + décollage est donnée
      // directement (cf. phrases_tour_sans_sol_avec_mission.json).
      responseKey=radioHasMissionContext()&&activeMission.type==='TourDePiste'
        ?'clearance-via-tour-tdp'
        :'clearance-via-tour';
    }else{
      responseKey='params_departure';
    }
  }
  // Terrain sans Sol : la demande de roulage passée à la Tour utilise sa
  // propre clé de réponse ("taxiViaTour...") pour ne jamais être confondue
  // avec la clairance de décollage ("params_departure...").
  if(svcKind==='tower'&&kind==='taxi')responseKey='taxiViaTour';
  const localTdpResponseKey=radioLocalTdpResponseKey(svcKind,kind);
  if(localTdpResponseKey)responseKey=localTdpResponseKey;
  // Mode radio autonome : les réponses "vol libre" sont enregistrées sous
  // des clés suffixées "Libre" dans phrases.json (ex. bonjourLibre) pour ne
  // jamais se mélanger avec les réponses liées à une mission.
  if(radioStandaloneMode)responseKey=responseKey+'Libre';
  const reply=radioPhrasePick('responses',svcKind,[responseKey],phraseCtx);
  const controllerRole=radioRoleForServiceKind(svcKind);
  if(reply){
    // Après une phrase reconnue au micro, affiche la réponse du contrôleur
    // immédiatement. La synthèse vocale est lancée ensuite et ne peut plus
    // laisser le statut « Phrase validée » à la place de cette réponse.
    if(!speakRequest){
      _lastRadioReply=reply;
      const replyEl=document.getElementById('radio-reply');
      if(replyEl)replyEl.textContent=reply;
    }
    radioSpeakSequence(speakRequest?[{text:requestText,role:'pilot'},{text:reply,role:controllerRole}]:[{text:reply,role:controllerRole}]);
  }else if(speakRequest){
    radioSpeakSequence([{text:requestText,role:'pilot'}]);
  }
}

function runwayForWind(a,windDir){
  const rwys=(a&&a.runways)||[];
  const wd=((Number(windDir)||0)%360+360)%360;
  const candidates=[];
  rwys.forEach(r=>{
    const hdg=((Number(r.trueHeading)||0)%360+360)%360;
    const diff=Math.abs((((hdg-wd+540)%360)-180));
    candidates.push({r,designator:r.designator||formatRunwayHeading(hdg),heading:hdg,diff});
  });
  if(!candidates.length)return null;
  // Piste en dur (enrobé ou béton) toujours prioritaire sur l'herbe/terre/gravier :
  // si le terrain en possède au moins une, seules celles-ci sont candidates,
  // même si le vent est mieux aligné avec une piste non revêtue.
  const isHard=c=>{const n=runwaySurfaceName(c.r);return n==='Dur'||n==='Béton';};
  const hardOnly=candidates.filter(isHard);
  const pool=hardOnly.length?hardOnly:candidates;
  const bestDiff=Math.min(...pool.map(c=>c.diff));
  return pool
    .filter(c=>c.diff<=bestDiff+8)
    .sort((a,b)=>{
      const aPlain=/^\d{1,2}$/i.test(String(a.designator||''))?1:0;
      const bPlain=/^\d{1,2}$/i.test(String(b.designator||''))?1:0;
      const aHard=isHard(a)?1:0;
      const bHard=isHard(b)?1:0;
      return bPlain-aPlain||
        (b.r.mainRunway?1:0)-(a.r.mainRunway?1:0)||
        bHard-aHard||
        runwayLength(b.r)-runwayLength(a.r)||
        a.diff-b.diff;
    })[0];
}

function radioWeatherText(){
  const a=currentRadioAirport();
  const d=_lastSimData||{};
  if(!ensureFrenchRegistrationForRadio(false))return radioRegistrationErrorText();
  const service=activeRadioServiceForAirport(a&&a.icao)||radioFallbackServiceForAirport(a);
  const name=a?(a.name||a.icao):'Terrain';
  const icao=a?(a.icao||''):'';
  const messages=RADIO_PHRASES.weatherMessages||{};
  if(!service){
    const active=radioActiveComText(d);
    return radioPhraseApplyTemplate(messages.noService||'',{
      name,
      coms:active?` Fréquence active : ${active}.`:'',
      freq:requiredRadioFreqText(a)
    });
  }
  if(isSivService(service))return radioSivTrafficText(service);
  if(isAirToAirService(service))return radioPhasePhraseText(a,service);
  const freq=service.freq?' '+service.freq:'';
  const windDir=((Math.round(Number(d.wind_direction)||0)%360)+360)%360;
  const windSpeed=Math.round(Number(d.wind_speed)||0);
  const rwy=runwayForWind(a,windDir);
  const qnh=radioQnhText(d);
  const temp=d.temperature_c!=null?Math.round(Number(d.temperature_c)):null;
  const ctx={
    name,airport:icao||name,serviceLabel:service.label||'',freq,radio:service.radio||'',
    windDir:String(windDir).padStart(3,'0'),windSpeed:String(windSpeed),
    runway:rwy&&rwy.designator||'',qnh,temp:temp==null?'':String(temp),
    altitude:String(Math.round(Number(d.altitude)||0)),heading:String(Math.round(Number(d.heading)||0))
  };
  const parts=[];
  const add=(key,extra={})=>{
    const template=messages[key];
    if(template)parts.push(radioPhraseApplyTemplate(template,{...ctx,...extra}));
  };
  add('received');
  add('simulated');
  add(windSpeed>0?'wind':'windCalm');
  if(rwy&&rwy.designator)add('runway');
  add('qnh');
  if(temp!=null)add('temperature');
  if(d.altitude!=null&&hasValidSimData(d))add('aircraftReceived');
  if(service.type==='atis')add('atisAdvice');
  else if(service.type==='afis')add('afisAdvice');
  else if(service.type==='auto')add('autoAdvice');
  return parts.filter(Boolean).join(' ');
}

function radioWeatherRequest(){
  updateRadioPanel();
  if(!ensureFrenchRegistrationForRadio())return;
  const a=currentRadioAirport();
  const service=activeRadioServiceForAirport(a&&a.icao)||radioFallbackServiceForAirport(a);
  if(radioServiceKind(service)==='aa'){
    setRadioTranscript(radioStatusMessage('airToAirNoReply',{},'A/A : pas de réponse radio. Utilisez seulement les annonces types.'));
    showNotif(radioStatusMessage('airToAirNoReplyNotif',{},'A/A : aucune réponse radio'));
    return;
  }
  radioSpeak(radioWeatherText());
}

async function handleRadioTranscript(text){
  // Même normalisation que la validation des demandes affichées, notamment
  // pour les transcriptions « vend arrière » / « vent arrière ».
  const t=radioPhraseKey(text||'');
  if(!radioMissionOrStandaloneActive())return;
  const ctx=currentValidatedRadioContext();
  const a=_radioSessionAirport||ctx.airport;
  const service=_radioSessionService||ctx.service;

  // Le micro dépend uniquement de la fréquence déjà reconnue et affichée.
  if(!a||!service){
    setRadioTranscript(radioStatusMessage('micBlockedNoFrequency',{},'Micro bloqué : aucune fréquence reconnue dans le panneau radio.'));
    showNotif(radioStatusMessage('radioFrequencyNotValidated',{},'Fréquence radio non validée'));
    return;
  }
  const svcKind=radioServiceKind(service);
  // Filet de sécurité : si une diffusion ATIS automatique est restée active
  // (drapeau non nettoyé) alors qu'on traite maintenant une phrase sur un
  // autre service, on la coupe explicitement ici. Sans ça, _activeAtisBroadcastKey
  // peut bloquer silencieusement TOUTE réponse radio (texte et voix), sur
  // n'importe quel aérodrome, tant qu'il n'est pas nettoyé par ailleurs.
  if(svcKind!=='atis'&&_activeAtisBroadcastKey)stopAutomaticAtis();
  const wantsRepeat=/\b(répète|répéter|repete|repeter|répétez|repetez|redis|redites)\b/i.test(t);
  if(wantsRepeat){
    if(_lastRadioReply)radioSpeak(_lastRadioReply);
    else showNotif('Aucune réponse radio à répéter');
    return;
  }
  let spokenTransponderCode=radioTransponderCodeFromTranscript(text);
  let expectedSquawk='';
  if(['ground','tower','siv'].includes(svcKind)){
    expectedSquawk=normalizeSquawkCode(radioExpectedTransponderCodeForService(a,service,svcKind));
    if(!spokenTransponderCode&&expectedSquawk&&radioTransponderDigitsInTranscript(text).includes(expectedSquawk)){
      spokenTransponderCode=expectedSquawk;
    }
  }
  if(spokenTransponderCode){
    _pendingTransponderReadback={code:spokenTransponderCode,at:Date.now()};
    if(spokenTransponderCode===expectedSquawk&&['ground','tower','siv'].includes(svcKind)){
      startSivTransponderCheck(expectedSquawk,radioCallsign()||pilotRegistration()||'F-XXXX',svcKind);
      if(svcKind==='tower'&&_lastSimData&&_lastSimData.on_ground&&!radioTowerActsAsGround(a,service)){
        scheduleTowerLineupClearance(a,service,radioCallsign()||pilotRegistration()||'F-XXXX',lockedTowerRunway(a,service)||runwayForWind(a,_lastSimData.wind_direction));
      }
    }
  }
  const transponderReadback=radioTransponderReadbackMatches(text);
  if(transponderReadback&&_sivXpdrCheck){
    if(!_sivXpdrCheck.readbackConfirmed)_sivXpdrCheck.readbackAt=Date.now();
    _sivXpdrCheck.readbackConfirmed=true;
    _pendingTransponderReadback=null;
    completeTransponderCheckIfReady();
  }
  const qnhReadback=t.includes('qnh')&&(t.includes('rappel')||t.includes('mainten')||t.includes('roul'));
  const isCollation=transponderReadback||qnhReadback||!!(t&&(t.includes('bien recu')||t.includes('information recue')||t.includes('collation')||/^recu\b/.test(t)));
  if(radioScriptKind(svcKind)){
    await radioScriptHandleTranscript(text,t,svcKind,a,service,isCollation);
    return;
  }
  if(svcKind==='siv'&&t.includes('suivi de vol')&&t.includes('information de trafic')){
    await radioRequestPreset('params',{speakRequest:false});
    return;
  }
  if(svcKind==='siv'&&t&&
    (t.includes('bonjour')||/\binfo\b/.test(t))&&
    !/(suivi|trafic|meteo|qnh|transit|changement|change|cap|niveau|quitte|quitter|frequence|transpondeur)/.test(t)){
    await radioRequestPreset('bonjour',{speakRequest:false});
    return;
  }
  const phraseMarked=t?markRadioPhraseSpoken(text,null,{preserveReply:isCollation}):false;
  const hasRadioNumber=/\b\d{1,5}\b/.test(t)||
    /\b(zero|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|mille)\b/.test(t);
  const sivActualChange=svcKind==='siv'&&!!t&&hasRadioNumber&&!isCollation&&
    (t.includes('changement')||t.includes('change'))&&
    (t.includes('cap')||t.includes('altitude')||t.includes('niveau')||t.includes('montee')||t.includes('descente'));
  if(sivActualChange){
    await radioRequestPreset('change',{speakRequest:false});
    return;
  }
  const matchedCollation=phraseMarked&&_lastRadioMatchedPhase==='Collationnement';
  if(matchedCollation){
    // Un collationnement termine l'échange : aucune nouvelle réponse du service.
    return;
  }
  if(t&&!phraseMarked&&!isCollation&&svcKind==='siv'){
    return;
  }
  if(svcKind==='siv'&&t){
    if(isCollation){
      return;
    }
    if(_radioSpokenKeys.has('radio-id|request-siv-trafic')){
      // Réponse du pilote à une information de trafic (avant « trafic » seul)
      if(t.includes('negatif')){
        await radioRequestPreset('traficnegatif',{speakRequest:false});
        return;
      }
      if(t.includes('en vue')||t.includes('visuel')){
        await radioRequestPreset('traficvue',{speakRequest:false});
        return;
      }
    }
    if(t.includes('quitte')||t.includes('quitter')||t.includes('quitton')||t.includes('au revoir')){
      await radioRequestPreset('quitter',{speakRequest:false});
      completeRadioFreeFlightDeparture(text);
      return;
    }
    if(t.includes('meteo')||t.includes('qnh')){
      await radioRequestPreset('meteo',{speakRequest:false});
      return;
    }
    if(t.includes('transit')){
      await radioRequestPreset('depart',{speakRequest:false});
      return;
    }
    if(t.includes('suivi de vol')||t.includes('en provenance')||t.includes('a destination')||t.includes('transpondeur')){
      await radioRequestPreset('params',{speakRequest:false});
      return;
    }
    if(t.includes('trafic')){
      await radioRequestPreset('trafic',{speakRequest:false});
      return;
    }
    if(t.includes('bonjour')){
      await radioRequestPreset('bonjour',{speakRequest:false});
      return;
    }
    return;
  }
  if(!t){
    // Silence volontaire si aucune phrase exploitable n'est reconnue.
  }else if(isCollation){
    // Le pilote collationne : la dernière réponse du service reste affichée et aucune réponse n'est émise.
  }else if(t.includes('trafic')){
    radioWeatherRequest();
  }else if(t.includes('parametre')||t.includes('parametres')||t.includes('roulage')||t.includes('demande')||t.includes('consigne')||t.includes('information de trafic')){
    await radioRequestPreset('params',{speakRequest:false});
  }else if(t.includes('quitte')||t.includes('quitter')||t.includes('quitton')||t.includes('frequence')||t.includes('au revoir')){
    await radioRequestPreset('quitter',{speakRequest:false});
    completeRadioFreeFlightDeparture(text);
  }else if(t.includes('piste degagee')||t.includes('degage')){
    await radioRequestPreset('pistedegagee',{speakRequest:false});
  }else if(t.includes('finale')){
    // En Tours de piste, "pour un complet" met fin à la boucle touché-décollé
    // et enchaîne vers piste dégagée/parking, au lieu de relancer un tour.
    const isTdpComplet=radioHasMissionContext()&&activeMission.type==='TourDePiste'&&t.includes('complet');
    await radioRequestPreset(isTdpComplet?'finalecomplet':'finale',{speakRequest:false});
  }else if(t.includes('vent arriere')){
    await radioRequestPreset('ventarriere',{speakRequest:false});
  }else if(t.includes('point d attente')||t.includes('pret')||t.includes('depart')||t.includes('decollage')||t.includes('penetre')||t.includes('penetron')||t.includes('remonte')||t.includes('remonton')||t.includes('transit')||t.includes('contacter la tour')){
    await radioRequestPreset('depart',{speakRequest:false});
  }else if(t.includes('bonjour')){
    await radioRequestPreset('bonjour',{speakRequest:false});
  }else if(t.includes('meteo')||t.includes('atis')){
    radioWeatherRequest();
  }else{
    // Demande non reconnue: on reste silencieux pour ne pas couper le pilote.
  }
}

function finalizeRadioTranscript(){
  const txt=_radioTranscriptBuffer.trim();
  _radioTranscriptBuffer='';
  if(txt)handleRadioTranscript(txt);
}

function stopRadioListening(){
  if(!_radioListening)return;
  _radioListening=false;
  _radioPushToTalk=false;
  updateRadioPanel();
  try{
    if(typeof wsClient!=='undefined'&&wsClient&&wsConnected){
      wsClient.send(JSON.stringify({type:'radioListenStop'}));
    }
  }catch(e){
    console.warn('Arrêt reconnaissance radio (bridge)',e);
  }
  // Le texte final arrive de façon asynchrone (message WS 'radioTranscript'
  // avec final:true) et déclenche handleRadioTranscript via
  // handleRadioTranscriptMessage() — rien à finaliser ici de façon synchrone.
}

async function startRadioListening(options={}){
  const pushToTalk=!!options.pushToTalk;
  const pttLabel=options.pttLabel||RADIO_PTT_KEY;

  // Le panneau radio est la source de vérité : s'il affiche une fréquence
  // reconnue, le micro est autorisé.
  const ctx=currentValidatedRadioContext();
  const a=ctx.airport;
  const activeService=ctx.service;
  if(!a||!activeService){
    setRadioTranscript(radioStatusMessage('micBlockedNoFrequency',{},'Micro bloqué : aucune fréquence reconnue dans le panneau radio.'));
    showNotif(radioStatusMessage('radioFrequencyNotValidated',{},'Fréquence radio non validée'));
    return;
  }

  if(_radioListening){
    if(!pushToTalk)stopRadioListening();
    return;
  }

  if(!radioSpeechAvailable()){
    setRadioTranscript('Micro indisponible : bridge FlyFranceVFR non connecté.');
    showNotif('Bridge non connecté — reconnaissance radio indisponible');
    return;
  }

  // Fige le terrain et le service pour toute la durée de cette transmission.
  _radioSessionAirport=a;
  _radioSessionService=activeService;
  _radioTranscriptBuffer='';
  _radioPushToTalk=pushToTalk;
  _radioPttLabel=pttLabel;
  _radioListening=true;
  updateRadioPanel();
  setRadioTranscript('',true);
  setRadioTranscript(pushToTalk
    ?radioStatusMessage('micOpenHold',{command:pttLabel},`Micro ouvert : maintenez ${pttLabel} et parlez.`)
    :radioStatusMessage('micOpenSpeak',{},'Micro ouvert : parlez maintenant.'));
  showNotif(pushToTalk
    ?radioStatusMessage('radioPttHeld',{command:pttLabel},`Radio : ${pttLabel} maintenu`)
    :radioStatusMessage('radioListening',{},'Radio : écoute micro...'));
  try{
    wsClient.send(JSON.stringify({type:'radioListenStart',pushToTalk,pttLabel}));
  }catch(e){
    console.warn('Radio micro indisponible',e);
    _radioListening=false;
    _radioPushToTalk=false;
    _radioSessionAirport=null;
    _radioSessionService=null;
    updateRadioPanel();
    setRadioTranscript(`Impossible de démarrer la reconnaissance : ${e&&e.message||e}`);
    showNotif('Micro radio indisponible (bridge)');
  }
}

// Appelé depuis flyfrancevfr.html (wsClient.onmessage) à chaque message
// {type:'radioTranscript', text, final, error?} reçu du bridge.
function handleRadioTranscriptMessage(d){
  if(!d)return;
  if(d.error){
    _radioListening=false;
    _radioPushToTalk=false;
    _radioSessionAirport=null;
    _radioSessionService=null;
    updateRadioPanel();
    setRadioTranscript(`Reconnaissance radio indisponible : ${d.error}`);
    showNotif('Reconnaissance radio indisponible (bridge)');
    return;
  }
  const txt=String(d.text||'').trim();
  if(txt){
    const correctedTxt=txt.replace(/\bsolde\b/gi,'sol de');
    _radioTranscriptBuffer=correctedTxt;
    setRadioTranscript(correctedTxt,true);
  }
  if(d.final){
    _radioListening=false;
    _radioPushToTalk=false;
    updateRadioPanel();
    finalizeRadioTranscript();
    _radioSessionAirport=null;
    _radioSessionService=null;
  }
}

function atisWeatherSnapshot(a,d=_lastSimData||{}){
  const windDir=((Math.round(Number(d.wind_direction)||0)%360)+360)%360;
  const rwy=runwayForWind(a,windDir);
  const visibility=Number(d.visibility_m);
  return {
    windDir,
    windSpeed:Math.max(0,Math.round(Number(d.wind_speed)||0)),
    qnh:Math.round(Number(d.qnh_hpa)||0),
    temp:Math.round(Number(d.temperature_c)||0),
    runway:String(rwy&&rwy.designator||''),
    visibilityM:Number.isFinite(visibility)&&visibility>0?Math.round(visibility):0,
    precipState:Math.round(Number(d.precip_state)||0)
  };
}

function radioAtisUtcParts(d=_lastSimData||{}){
  const seconds=Number(d.zulu_seconds);
  if(Number.isFinite(seconds)&&seconds>=0){
    const normalized=((Math.floor(seconds)%86400)+86400)%86400;
    return {hour:Math.floor(normalized/3600),minute:Math.floor((normalized%3600)/60)};
  }
  const now=new Date();
  return {hour:now.getUTCHours(),minute:now.getUTCMinutes()};
}

function atisMessageVersion(a,d=_lastSimData||{}){
  const now=new Date();
  const nowMs=Date.now();
  const weatherConfirmationMs=30000;
  const minimumRevisionIntervalMs=120000;
  const id=String(a&&a.icao||'ATIS');
  const date=`${now.getUTCFullYear()}-${now.getUTCMonth()+1}-${now.getUTCDate()}`;
  const hour=radioAtisUtcParts(d).hour;
  const weather=atisWeatherSnapshot(a,d);
  let state=_atisMessageStates[id];
  if(!state||state.date!==date){
    state={date,hour,sequence:hour,weather,revision:0,lastRevisionAt:nowMs,pendingWeatherSince:0,pendingWeather:null};
    _atisMessageStates[id]=state;
  }else{
    const old=state.weather||weather;
    const windDiff=Math.abs((((weather.windDir-old.windDir)+540)%360)-180);
    const significant=weather.runway!==old.runway
      ||(Math.max(weather.windSpeed,old.windSpeed)>=3&&windDiff>=30)
      ||Math.abs(weather.windSpeed-old.windSpeed)>=5
      ||((weather.visibilityM>=10000)!==(old.visibilityM>=10000))
      ||Math.abs(weather.visibilityM-old.visibilityM)>=1000
      ||weather.precipState!==old.precipState
      ||Math.abs(weather.qnh-old.qnh)>=2
      ||Math.abs(weather.temp-old.temp)>=3;
    if(hour!==state.hour){
      state.sequence=(state.sequence+1)%26;
      state.hour=hour;
      state.weather=weather;
      state.revision++;
      state.lastRevisionAt=nowMs;
      state.pendingWeatherSince=0;
      state.pendingWeather=null;
    }else if(significant){
      // MSFS peut faire osciller le vent, la piste ou la visibilité à chaque
      // télémétrie. On attend que le changement persiste avant de publier un
      // nouveau bulletin et on empêche plusieurs lettres en quelques secondes.
      if(!state.pendingWeatherSince)state.pendingWeatherSince=nowMs;
      state.pendingWeather=weather;
      const confirmed=nowMs-state.pendingWeatherSince>=weatherConfirmationMs;
      const intervalElapsed=nowMs-Number(state.lastRevisionAt||0)>=minimumRevisionIntervalMs;
      if(confirmed&&intervalElapsed){
        state.sequence=(state.sequence+1)%26;
        state.weather=state.pendingWeather||weather;
        state.revision++;
        state.lastRevisionAt=nowMs;
        state.pendingWeatherSince=0;
        state.pendingWeather=null;
      }
    }else{
      state.pendingWeatherSince=0;
      state.pendingWeather=null;
    }
  }
  return {
    letter:String.fromCharCode(65+(state.sequence%26)),
    key:`${state.date}|${state.sequence}|${state.revision}`
  };
}

function radioAtisVisibilityText(d=_lastSimData||{}){
  const meters=Number(d.visibility_m);
  if(!Number.isFinite(meters)||meters<=0)return '';
  const atis=RADIO_PHRASES.atisMessages||{};
  if(meters>=9950)return atis.visibilityTenOrMore||'Visibilité supérieure à 10 kilomètres.';
  if(meters>=4950){
    const kilometers=Math.min(9,Math.max(5,Math.round(meters/1000)));
    return radioPhraseApplyTemplate(atis.visibilityKilometers||'Visibilité {visibilityKilometers} kilomètres.',{
      visibilityKilometers:String(kilometers)
    });
  }
  const rounded=Math.max(50,Math.round(meters/(meters<1000?50:100))*(meters<1000?50:100));
  return radioPhraseApplyTemplate(atis.visibilityMeters||'Visibilité {visibilityMeters} mètres.',{
    visibilityMeters:String(rounded)
  });
}

function radioAtisPrecipitationText(d=_lastSimData||{}){
  const state=Math.round(Number(d.precip_state)||0);
  const atis=RADIO_PHRASES.atisMessages||{};
  const rain=(state&4)===4;
  const snow=(state&8)===8;
  if(rain&&snow)return atis.precipRainSnow||'Pluie et neige.';
  if(snow)return atis.precipSnow||'Neige.';
  if(rain)return atis.precipRain||'Pluie.';
  return '';
}

function radioAtisBroadcastText(a,service,d=_lastSimData||{},infoLetter='A'){
  const name=radioAirportNameText(a);
  const utc=radioAtisUtcParts(d);
  const utcHour=String(utc.hour).padStart(2,'0');
  const utcMinute=String(utc.minute).padStart(2,'0');
  const windDir=((Math.round(Number(d.wind_direction)||0)%360)+360)%360;
  const windSpeed=Math.max(0,Math.round(Number(d.wind_speed)||0));
  const rwy=runwayForWind(a,windDir);
  const qnh=Number(d.qnh_hpa);
  const temp=Number(d.temperature_c);
  const atis=RADIO_PHRASES.atisMessages||{};
  const ctx={name,infoLetter,utcHour,utcMinute,runway:rwy&&rwy.designator||'',windDir:String(windDir).padStart(3,'0'),windSpeed:String(windSpeed),temp:String(Math.round(temp)),qnh:String(Math.round(qnh))};
  const parts=[];
  const add=(key)=>{const template=atis[key];if(template)parts.push(radioPhraseApplyTemplate(template,ctx));};
  add('header');
  if(rwy&&rwy.designator)add('runway');
  add(windSpeed>0?'wind':'windCalm');
  const visibilityText=radioAtisVisibilityText(d);
  if(visibilityText)parts.push(visibilityText);
  const precipitationText=radioAtisPrecipitationText(d);
  if(precipitationText)parts.push(precipitationText);
  if(Number.isFinite(temp))add('temperature');
  if(Number.isFinite(qnh)&&qnh>=850&&qnh<=1100)add('qnh');
  add('firstContact');
  return parts.join(' ');
}

function stopAutomaticAtis(){
  _atisLoopToken++;
  if(_atisLoopTimer){clearTimeout(_atisLoopTimer);_atisLoopTimer=null;}
  if(_atisLoopSpeaking&&voiceGuidanceAvailable()){
    try{window.speechSynthesis.cancel();}catch(e){}
  }
  _atisLoopSpeaking=false;
  _activeAtisBroadcastKey='';
  _atisMissingSince=0;
}

function atisSpeechSections(message){
  const speech=radioSpeechText(message);
  const sections=[];
  const utcMarker='U T C.';
  const utcEnd=speech.indexOf(utcMarker);
  let remaining=speech;
  if(utcEnd>=0){
    const end=utcEnd+utcMarker.length;
    sections.push({text:speech.slice(0,end).trim(),pause:750});
    remaining=speech.slice(end).trim();
  }
  const runway=remaining.match(/^(Piste en service[^.]*\.)\s*/i);
  if(runway){
    sections.push({text:runway[1].trim(),pause:750});
    remaining=remaining.slice(runway[0].length).trim();
  }
  if(remaining)sections.push({text:remaining,pause:0});
  return sections.length?sections:[{text:speech,pause:0}];
}

function startAutomaticAtisLoop(message,key){
  const token=++_atisLoopToken;
  let atisVoice=null;
  let voiceReady=false;
  _lastRadioReply=message;
  const reply=document.getElementById('radio-reply');
  if(reply)reply.textContent=message;
  if(_atisLoopTimer){clearTimeout(_atisLoopTimer);_atisLoopTimer=null;}
  if(!voiceGuidanceAvailable())return;
  try{window.speechSynthesis.cancel();}catch(e){}
  const speakOnce=()=>{
    if(token!==_atisLoopToken||key!==_activeAtisBroadcastKey)return;
    if(!voiceReady){
      voiceReady=true;
      _atisLoopTimer=setTimeout(()=>{
        if(token!==_atisLoopToken||key!==_activeAtisBroadcastKey)return;
        atisVoice=radioVoiceForRole('atis');
        speakOnce();
      },1200);
      return;
    }
    const sections=atisSpeechSections(message);
    let sectionIndex=0;
    const speakSection=()=>{
      if(token!==_atisLoopToken||key!==_activeAtisBroadcastKey)return;
      if(sectionIndex>=sections.length){
        _atisLoopSpeaking=false;
        _atisLoopTimer=setTimeout(speakOnce,2500);
        return;
      }
      const section=sections[sectionIndex];
      const utterance=new SpeechSynthesisUtterance(section.text);
      applyRadioVoiceProfile(utterance,'atis');
      if(atisVoice)utterance.voice=atisVoice;
      _atisLoopSpeaking=true;
      const next=()=>{
        if(token!==_atisLoopToken||key!==_activeAtisBroadcastKey)return;
        sectionIndex++;
        _atisLoopTimer=setTimeout(speakSection,section.pause);
      };
      utterance.onend=next;
      utterance.onerror=next;
      window.speechSynthesis.speak(utterance);
    };
    speakSection();
  };
  speakOnce();
}

function updateAutomaticAtis(a,activeService,d=_lastSimData||{}){
  if(!radioMissionOrStandaloneActive()){
    if(_activeAtisBroadcastKey)stopAutomaticAtis();
    return;
  }
  const isActiveAtis=!!(activeService&&radioServiceKind(activeService)==='atis');
  if(!isActiveAtis){
    if(activeService){
      _atisMissingSince=0;
      if(_activeAtisBroadcastKey)stopAutomaticAtis();
    }else if(_activeAtisBroadcastKey){
      if(!_atisMissingSince)_atisMissingSince=Date.now();
      if(Date.now()-_atisMissingSince>=2000)stopAutomaticAtis();
    }
    return;
  }
  _atisMissingSince=0;
  if(!a||!hasValidSimData(d))return;
  const version=atisMessageVersion(a,d);
  const key=`${a.icao||''}|${activeService.radio||''}|${activeService.activeFreq||activeService.freq||''}|${version.key}`;
  if(_activeAtisBroadcastKey===key)return;
  if(_activeAtisBroadcastKey&&_atisLoopSpeaking)return;
  if(!_activeAtisBroadcastKey&&radioSpeechQueueBusy())return;
  if(_activeAtisBroadcastKey)stopAutomaticAtis();
  _activeAtisBroadcastKey=key;
  startAutomaticAtisLoop(radioAtisBroadcastText(a,activeService,d,version.letter),key);
}

function updateRadioPanel(){
  const standaloneToggle=document.getElementById('radio-standalone-toggle');
  if(standaloneToggle&&standaloneToggle.checked!==radioStandaloneMode)standaloneToggle.checked=radioStandaloneMode;
  const a=currentRadioAirport();
  updateRadioFreeFlightState(a);
  updateTdpLoopState();
  const fallback=radioFallbackServiceForAirport(a);
  const activeService=activeRadioServiceForAirport(a&&a.icao);

  // Ce qui est affiché comme « fréquence reconnue » est mémorisé et sera
  // utilisé directement par le micro. Si le panneau affiche qu'aucune
  // fréquence n'est reconnue, l'autorisation est retirée.
  if(activeService){
    _radioValidatedAirport=a;
    _radioValidatedService=activeService;
  }else{
    _radioValidatedAirport=null;
    _radioValidatedService=null;
  }

  // Efface l'ancienne réponse affichée dès que la fréquence/le service
  // effectivement réglé change (ex: ATIS -> Sol), pour éviter qu'un message
  // resté à l'écran (ex: le message ATIS) ne s'affiche encore une fois sur
  // une autre fréquence. Ne s'applique que sur un vrai changement, pas à
  // chaque rafraîchissement du panneau.
  const replyServiceKey=activeService?`${activeService.type}|${(a&&a.icao)||''}|${radioFreqText(activeService.freq||activeService.activeFreq||'')}`:null;
  if(replyServiceKey!==_radioReplyServiceKey){
    _radioReplyServiceKey=replyServiceKey;
    _lastRadioReply='';
    const reply=document.getElementById('radio-reply');
    if(reply)reply.textContent='';
  }
  const service=activeService||fallback;
  const line=document.getElementById('radio-airport-line');
  const svc=document.getElementById('radio-service-line');
  const micStatus=document.getElementById('radio-mic-status');
  const pttLearnBtn=document.getElementById('radio-ptt-learn-btn');
  const heard=document.getElementById('radio-heard');
  const d=_lastSimData||{};
  const airMode=!!(service&&isAirToAirService(service));
  const sivMode=!!(service&&isSivService(service));
  const aaAirport=radioAirportUsesAirToAir(a&&a.icao);
  if(line){
    if(sivMode)line.textContent=String((activeService&&activeService.siv&&activeService.siv.name)||activeService.desc||'SIV');
    else if(activeService)line.textContent=a?`${a.icao} · ${a.name}`:'Aucun aérodrome détecté';
    else line.textContent='Réglez une fréquence COM reconnue.';
  }
  if(micStatus){
    const ok=radioSpeechAvailable();
    const freqOk=!!activeService;
    const commandLabel=_radioPttLearnMode?'appuyez sur une touche ou un bouton joystick...':radioPttLabel();
    micStatus.textContent=!ok?'Micro indisponible'
      :(_radioListening?`Commande radio : ${commandLabel} · écoute en cours`
      :`Commande radio : ${commandLabel}`);
    micStatus.style.opacity=(ok&&freqOk)?'1':'.45';
    micStatus.title=!ok?'Reconnaissance vocale indisponible dans FlyFranceVFR':(!freqOk?'Réglez une fréquence COM reconnue pour activer le micro':'Commande radio : '+commandLabel);
  }
  if(pttLearnBtn)pttLearnBtn.textContent=_radioPttLearnMode?'En attente...':'Modifier';
  const fallbackLabel=String(fallback.label||'Info').toUpperCase()==='A/A'?'':(fallback.label||'Info');
  const fallbackFreqText=`${fallbackLabel?fallbackLabel+' ':''}${fallback.freq||'123.500'}`;
  if(heard){
    if(heard.parentElement)heard.parentElement.style.display='';
    heard.innerHTML=!activeService
      ?''
      :!radioCallsign()
      ?`<div style="color:#ff5c70;margin-top:6px;">${htmlEscape(radioRegistrationErrorText())}</div>`
      :radioPossibleRequestsHtml(a,activeService);
  }
  if(svc){
    if(!radioMissionOrStandaloneActive())svc.textContent='Sélectionnez une mission ou activez le mode radio autonome.';
    else if(activeService)svc.textContent=`Fréquence reconnue : ${activeService.radio} ${activeService.activeFreq} · ${sivMode?'SIV':airMode?'A/A':activeService.label}`;
    else svc.textContent=`Exemple : ${fallbackFreqText}`;
  }
  const replyTitle=document.getElementById('radio-reply-title');
  if(replyTitle){
    let label='Contrôleur';
    if(activeService){
      if(sivMode)label='SIV';
      else if(airMode)label='A/A';
      else{
        const kindLabels={atis:'ATIS',tower:'Tour',ground:'Sol',afis:'AFIS'};
        label=kindLabels[activeService.type]||activeService.label||'Contrôleur';
      }
    }
    replyTitle.textContent=label;
  }
  updateAutomaticAtis(a,activeService,d);
}

function updateTaxiSpeedWarning(d=_lastSimData||{}){
  const now=Date.now();
  const a=currentRadioAirport();
  const service=activeRadioServiceForAirport(a&&a.icao);
  const groundActive=!!(service&&radioServiceKind(service)==='ground');
  const taxiSpeed=Math.max(0,Number(d.ground_speed));
  if(!hasValidSimData(d)||!d.on_ground||!d.engine_on||!groundActive||!Number.isFinite(taxiSpeed)||taxiSpeed<=18){
    _taxiOverspeedSince=0;
    return;
  }
  if(taxiSpeed<=20){
    _taxiOverspeedSince=0;
    return;
  }
  if(!_taxiOverspeedSince)_taxiOverspeedSince=now;
  if(now-_taxiOverspeedSince<3000||now-_lastTaxiSpeedWarningAt<30000)return;
  _lastTaxiSpeedWarningAt=now;
  const cs=radioShortCallsign(radioCallsign()||pilotRegistration()||'F-XXXX');
  const msg=radioPhraseApplyTemplate((RADIO_PHRASES.alerts||{}).taxiOverspeed||'',{cs,shortCs:cs});
  radioSpeak(msg,'radio');
}

function radioGamepadLabel(binding){
  if(!binding)return 'joystick';
  return `joystick B${Number(binding.button)+1}`;
}
function radioKeyboardCode(){return (_radioKeyboardPtt&&_radioKeyboardPtt.code)||RADIO_PTT_KEY;}
function radioKeyboardLabel(){return (_radioKeyboardPtt&&_radioKeyboardPtt.label)||'F9';}
function radioPttLabel(){return _radioGamepadPtt?radioGamepadLabel(_radioGamepadPtt):'Touche '+radioKeyboardLabel();}
function resetRadioPttPressState(){
  // L'apprentissage et l'utilisation normale du PTT partagent les mêmes
  // variables. Toujours repartir d'un état relâché évite que la pression
  // ayant servi à choisir la commande bloque le premier véritable appel micro.
  _radioGamepadPressed=false;
  _radioGamepadLearnWaitRelease=false;
  _radioGamepadLearnBaseline.clear();
}
function radioKeyLabel(e){
  if(!e)return 'touche';
  if(e.key&&e.key.length===1)return e.key.toUpperCase();
  return String(e.key||e.code||'touche').replace(/^Key/,'').replace(/^Digit/,'');
}
function saveRadioKeyboardPtt(binding){
  _radioKeyboardPtt=binding||{code:RADIO_PTT_KEY,label:'F9'};
  localStorage.setItem('flyfrancevfr_radio_keyboard_ptt',JSON.stringify(_radioKeyboardPtt));
  _radioGamepadPtt=null;
  localStorage.removeItem('flyfrancevfr_radio_gamepad_ptt');
  resetRadioPttPressState();
  updateRadioPanel();
  if(typeof save==='function')save();
}
function saveRadioGamepadPtt(binding){
  _radioGamepadPtt=binding;
  if(binding)localStorage.setItem('flyfrancevfr_radio_gamepad_ptt',JSON.stringify(binding));
  else localStorage.removeItem('flyfrancevfr_radio_gamepad_ptt');
  updateRadioPanel();
  if(typeof save==='function')save();
}
// Commande radio (clavier / joystick) incluse dans la sauvegarde du bridge,
// pour survivre à une désinstallation avec conservation de la progression.
function exportRadioPttSettings(){
  return {keyboard:_radioKeyboardPtt,gamepad:_radioGamepadPtt};
}
function importRadioPttSettings(s){
  if(!s||typeof s!=='object')return;
  const kb=s.keyboard;
  if(kb&&typeof kb.code==='string'&&kb.code){
    _radioKeyboardPtt={code:kb.code,label:String(kb.label||kb.code)};
    try{localStorage.setItem('flyfrancevfr_radio_keyboard_ptt',JSON.stringify(_radioKeyboardPtt));}catch(e){}
  }
  _radioGamepadPtt=(s.gamepad&&typeof s.gamepad==='object')?s.gamepad:null;
  try{
    if(_radioGamepadPtt)localStorage.setItem('flyfrancevfr_radio_gamepad_ptt',JSON.stringify(_radioGamepadPtt));
    else localStorage.removeItem('flyfrancevfr_radio_gamepad_ptt');
  }catch(e){}
  updateRadioPanel();
}
function startRadioPttLearn(){
  _radioPttLearnMode=true;
  _radioPttLearnStartedAt=Date.now();
  _radioGamepadLearnWaitRelease=false;
  _radioGamepadLearnBaseline=new Set();

  if(_radioKeyboardLearnTimer){
    clearTimeout(_radioKeyboardLearnTimer);
    _radioKeyboardLearnTimer=null;
  }
  if(_radioGamepadLearnTimeout){
    clearTimeout(_radioGamepadLearnTimeout);
    _radioGamepadLearnTimeout=null;
  }

  // Mémorise les boutons déjà enfoncés afin qu'ils ne soient pas
  // sélectionnés immédiatement à l'ouverture du mode apprentissage.
  try{
    const pads=(navigator.getGamepads?navigator.getGamepads():[])||[];
    for(const pad of pads){
      if(!pad)continue;
      Array.from(pad.buttons||[]).forEach((btn,idx)=>{
        if(btn&&btn.pressed)_radioGamepadLearnBaseline.add(`${pad.index}:${idx}`);
      });
    }
  }catch(e){
    console.warn('Lecture joystick indisponible pendant apprentissage',e);
  }

  _radioGamepadPressed=false;
  startRadioGamepadLoop();
  updateRadioPanel();
  showNotif('Appuyez sur une touche clavier ou un bouton joystick');

  // Évite que le programme reste bloqué indéfiniment en mode attente.
  _radioGamepadLearnTimeout=setTimeout(()=>{
    if(!_radioPttLearnMode)return;
    _radioPttLearnMode=false;
    _radioGamepadLearnBaseline.clear();
    _radioGamepadLearnWaitRelease=false;
    _radioGamepadLearnTimeout=null;
    updateRadioPanel();
    showNotif('Modification de la commande radio annulée');
  },15000);
}
function pollRadioGamepadPtt(){
  try{
    const pads=(navigator.getGamepads?navigator.getGamepads():[])||[];
    let targetPressed=false;
    let pressedCandidate=null;
    let anyButtonPressed=false;

    for(const pad of pads){
      if(!pad)continue;
      const buttons=Array.from(pad.buttons||[]);
      buttons.forEach((btn,idx)=>{
        const pressed=!!(btn&&btn.pressed);
        if(!pressed)return;
        anyButtonPressed=true;

        const buttonKey=`${pad.index}:${idx}`;
        if(_radioGamepadPtt&&pad.index===_radioGamepadPtt.index&&idx===_radioGamepadPtt.button){
          targetPressed=true;
        }

        // Pendant l'apprentissage, ignore un bouton qui était déjà maintenu
        // au moment où l'utilisateur a cliqué sur « Modifier ».
        if(_radioPttLearnMode&&!_radioGamepadLearnBaseline.has(buttonKey)&&!pressedCandidate){
          pressedCandidate={index:pad.index,button:idx,id:pad.id||'Joystick'};
        }
      });
    }

    // Les boutons présents dans la ligne de base deviennent utilisables
    // dès qu'ils ont été relâchés une première fois.
    if(_radioPttLearnMode&&_radioGamepadLearnBaseline.size){
      for(const key of [..._radioGamepadLearnBaseline]){
        const [padIndex,buttonIndex]=key.split(':').map(Number);
        const pad=pads[padIndex];
        const stillPressed=!!(pad&&pad.buttons&&pad.buttons[buttonIndex]&&pad.buttons[buttonIndex].pressed);
        if(!stillPressed)_radioGamepadLearnBaseline.delete(key);
      }
    }

    if(_radioPttLearnMode&&pressedCandidate){
      _radioPttLearnMode=false;
      _radioGamepadLearnWaitRelease=true;
      _radioGamepadLearnBaseline.clear();

      if(_radioKeyboardLearnTimer){
        clearTimeout(_radioKeyboardLearnTimer);
        _radioKeyboardLearnTimer=null;
      }
      if(_radioGamepadLearnTimeout){
        clearTimeout(_radioGamepadLearnTimeout);
        _radioGamepadLearnTimeout=null;
      }

      saveRadioGamepadPtt(pressedCandidate);

      // targetPressed avait ete calcule plus haut en fonction de l'ANCIEN bouton
      // assigne (avant la sauvegarde ci-dessus). Sans cette correction, la
      // verification "en attente du relachement" juste en dessous voit un
      // targetPressed=false (l'ancien bouton n'est pas presse) des ce meme tick,
      // et desarme _radioGamepadLearnWaitRelease immediatement au lieu d'attendre
      // le relachement du bouton qu'on vient reellement d'apprendre. Comme
      // _radioGamepadPressed reste force a true juste apres, le prochain appui
      // sur ce bouton n'est alors plus detecte comme un "nouvel appui" et ne
      // relance jamais startRadioListening -> le micro semble casse apres avoir
      // change de touche joystick.
      targetPressed=true;

      // Ne démarre pas le micro avec la pression ayant servi à choisir le bouton.
      // On attend que l'utilisateur relâche le bouton avant de réactiver le PTT.
      _radioGamepadPressed=true;
      showNotif(`Commande radio : ${radioPttLabel()}`);
    }

    if(_radioGamepadLearnWaitRelease){
      // On n'attend le relâchement QUE du bouton fraîchement assigné.
      // Attendre aussi le relâchement de tous les autres boutons/gâchettes
      // du joystick pouvait bloquer indéfiniment cet état (gâchette analogique
      // au repos détectée comme « pressed », autre bouton maintenu, etc.),
      // ce qui empêchait la toute première commande radio de fonctionner
      // tant que le logiciel n'était pas relancé.
      if(!targetPressed){
        _radioGamepadLearnWaitRelease=false;
        _radioGamepadPressed=false;
      }
    }else if(targetPressed&&!_radioGamepadPressed){
      _radioGamepadPressed=true;
      startRadioListening({pushToTalk:true,pttLabel:radioPttLabel()});
    }else if(!targetPressed&&_radioGamepadPressed){
      _radioGamepadPressed=false;
      stopRadioListening();
    }
  }catch(e){
    console.warn('Boucle joystick radio interrompue temporairement',e);
    _radioGamepadPressed=false;
  }finally{
    requestAnimationFrame(pollRadioGamepadPtt);
  }
}

function startRadioGamepadLoop(){
  if(_radioGamepadLoopStarted||!navigator.getGamepads)return;
  _radioGamepadLoopStarted=true;
  requestAnimationFrame(pollRadioGamepadPtt);
}

window.addEventListener('gamepadconnected',()=>{
  startRadioGamepadLoop();
  showNotif(_radioGamepadPtt?`Micro joystick : ${radioGamepadLabel(_radioGamepadPtt)}`:'Appuyez sur un bouton joystick pour le micro');
});
window.addEventListener('gamepaddisconnected',()=>showNotif('Joystick déconnecté'));
startRadioGamepadLoop();

window.addEventListener('load',()=>{
  setTimeout(()=>{
    requestMicrophonePermission({silent:true}).catch(e=>console.warn('Préparation micro reportée',e));
  },1200);
});

if(window.chrome&&window.chrome.webview){
  window.chrome.webview.addEventListener('message',event=>{
    const message=String(event.data||'');
    if(!message.startsWith('microphone-default-result:'))return;
    const parts=message.split(':');
    const success=parts[1]==='ok';
    const label=decodeURIComponent(parts.slice(2).join(':'));
    if(success){
      _micPermissionVerified=false;
      updateRadioDefaultMicrophoneLabel(label);
      showNotif(`Microphone radio sélectionné : ${label}`);
    }else{
      showNotif(`Impossible de sélectionner le microphone : ${label}`);
    }
  });
}


function radioIsInboundToAirport(a,d=_lastSimData||{}){
  if(!a||!a.icao||!hasValidSimData(d)||d.on_ground)return false;
  if(radioHasMissionContext()&&activeMission.type==='TourDePiste')return false;
  if(!radioHasMissionContext()){
    return radioFreeFlightScope(a)==='arrival'&&
      distNM(Number(d.lat),Number(d.lon),Number(a.lat),Number(a.lon))<=radioAirportCommRangeNm(a);
  }
  const targetIcao=String(activeMission.type==='Pax'&&activeMission.destAP
    ?activeMission.destAP.icao
    :activeMission.from||'').toUpperCase();
  if(targetIcao!==String(a.icao).toUpperCase())return false;
  if(activeMission.type!=='Pax'&&!['returning','landing_dest','shutdown'].includes(missionPhase||activeMission.phase||''))return false;
  return distNM(Number(d.lat),Number(d.lon),Number(a.lat),Number(a.lon))<=radioAirportCommRangeNm(a);
}

function radioInboundReportingPoint(a,d=_lastSimData||{}){
  if(!reportingPointData||!Array.isArray(reportingPointData.features)||!radioIsInboundToAirport(a,d))return null;
  const from={lat:Number(d.lat),lon:Number(d.lon)};
  const airport={lat:Number(a.lat),lon:Number(a.lon)};
  const direct=distNM(from.lat,from.lon,airport.lat,airport.lon);
  if(!Number.isFinite(direct)||direct<2)return null;
  const candidates=[];
  for(const f of reportingPointData.features){
    if(!f.geometry||f.geometry.type!=='Point')continue;
    const p=f.properties||{};
    const linked=(p.linkedAirports||[]).some(ap=>String(ap&&ap.code||'').toUpperCase()===String(a.icao).toUpperCase());
    if(!linked)continue;
    const c=f.geometry.coordinates||[];
    const point={lat:Number(c[1]),lon:Number(c[0])};
    if(!Number.isFinite(point.lat)||!Number.isFinite(point.lon))continue;
    const toPoint=distNM(from.lat,from.lon,point.lat,point.lon);
    const toAirport=distNM(point.lat,point.lon,airport.lat,airport.lon);
    const detour=Math.max(0,toPoint+toAirport-direct);
    if(toAirport<1||toAirport>25||detour>7)continue;
    const crossTrack=minDistancePointToSegmentNM(point.lat,point.lon,from,airport);
    candidates.push({feature:f,label:reportingPointLabel(p),radioName:String(p.name||reportingPointLabel(p)).toUpperCase(),lat:point.lat,lon:point.lon,toPoint,toAirport,score:detour*4+crossTrack*2+toPoint*.01-(p.compulsory?1:0)});
  }
  return candidates.sort((x,y)=>x.score-y.score||x.toPoint-y.toPoint)[0]||null;
}

function radioMissionDestinationPoint(){
  if(!radioHasMissionContext())return null;
  // Priorité : destPoint (mission FPL) > destAP (Pax) > dernier waypoint (Circuit)
  // > to (Pax) > poi (Tourist simple). Sans destPoint, une mission FPL n'a ni
  // destAP ni to ni poi : le scoring VRP de sortie retombait alors sur null et
  // {departurePoint} restait vide dans afis-leave / tour-leave-start.
  const wps=missionWaypoints(activeMission);
  const ap=activeMission.destPoint
    ||activeMission.destAP
    ||(wps.length?wps[wps.length-1]:null)
    ||airportByIcao(activeMission.to)
    ||activeMission.poi
    ||null;
  const lat=Number(ap&&ap.lat),lon=Number(ap&&(ap.lon??ap.lng));
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}

function radioDepartureReportingPoint(a,aircraft=null){
  if(!a||!reportingPointData||!Array.isArray(reportingPointData.features))return null;
  // Sans mission (vol libre), il n'y a pas de destination : seul le point le
  // plus proche de l'avion en vol peut alors être choisi.
  const destination=radioMissionDestinationPoint();
  const airport={lat:Number(a.lat),lon:Number(a.lon)};
  if(!Number.isFinite(airport.lat)||!Number.isFinite(airport.lon))return null;
  if(!destination&&!aircraft)return null;
  // Origine du calcul : l'avion s'il est fourni (AFIS / A-A en vol), sinon l'aérodrome.
  const origin=aircraft||airport;
  const direct=destination?distNM(origin.lat,origin.lon,destination.lat,destination.lon):0;
  if(destination&&(!Number.isFinite(direct)||direct<3))return null;
  const candidates=[];
  for(const f of reportingPointData.features){
    if(!f.geometry||f.geometry.type!=='Point')continue;
    const p=f.properties||{};
    const linked=(p.linkedAirports||[]).some(ap=>String(ap&&ap.code||'').toUpperCase()===String(a.icao).toUpperCase());
    if(!linked)continue;
    const c=f.geometry.coordinates||[];
    const point={lat:Number(c[1]),lon:Number(c[0])};
    if(!Number.isFinite(point.lat)||!Number.isFinite(point.lon))continue;
    const fromAirport=distNM(airport.lat,airport.lon,point.lat,point.lon);
    const fromOrigin=aircraft?distNM(origin.lat,origin.lon,point.lat,point.lon):fromAirport;
    const toDestination=destination?distNM(point.lat,point.lon,destination.lat,destination.lon):0;
    const detour=destination?Math.max(0,fromOrigin+toDestination-direct):0;
    if(fromAirport<1||fromAirport>25||detour>7)continue;
    const crossTrack=destination?minDistancePointToSegmentNM(point.lat,point.lon,origin,destination):0;
    // Avec la position de l'avion : le point le plus proche de l'avion l'emporte
    // (le filtre de détour écarte déjà les points derrière ou hors route).
    const score=aircraft
      ?fromOrigin+detour*.25-(p.compulsory?1:0)
      :detour*4+crossTrack*2+fromOrigin*.01-(p.compulsory?1:0);
    candidates.push({feature:f,label:reportingPointLabel(p),radioName:String(p.name||reportingPointLabel(p)).toUpperCase(),fromAirport,toDestination,score});
  }
  return candidates.sort((x,y)=>x.score-y.score||x.fromAirport-y.fromAirport)[0]||null;
}

function radioDepartureCtrAltitude(a){
  if(!a||!airspaceData||!Array.isArray(airspaceData.features)||typeof pointInGeometry!=='function')return '';
  const lat=Number(a.lat),lon=Number(a.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return '';
  const limits=[];
  for(const f of airspaceData.features){
    const p=f.properties||{};
    if(getAspKey(p.type||p.class||'',p.name)!=='CTR'||!pointInGeometry(lat,lon,f.geometry))continue;
    const upper=p.upperLimit||p.upperCeiling||p.ceil;
    if(!upper||typeof upper!=='object'||Number(upper.value)<=0||Number(upper.unit)!==1)continue;
    limits.push(Number(upper.value));
  }
  if(!limits.length)return '';
  return `${Math.min(...limits)} pieds`;
}

function radioReportingPointMatchesTranscript(text,reportPoint){
  if(!reportPoint||!reportPoint.radioName)return false;
  const spoken=radioPhraseKey(text);
  const compact=String(reportPoint.radioName).toUpperCase().replace(/[^A-Z0-9]/g,'');
  const letters=compact.toLowerCase().split('').join(' ');
  return spoken.includes('point')&&(spoken.includes(letters)||spoken.includes(compact.toLowerCase()));
}

function radioRestrictedZoneName(f,key){
  const raw=String(featureLabel(f)||'zone').replace(/^LF[\s-]*/i,'').trim();
  const clean=raw.replace(/\s+/g,' ');
  if(new RegExp('^'+key+'\\b','i').test(clean))return clean;
  return `${key} ${clean}`;
}

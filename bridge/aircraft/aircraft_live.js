/* FlyFranceVFR — Avion détecté par MSFS : le profil est construit à la volée depuis SimConnect.
   Rien n'est mémorisé : ni table d'avions, ni profil créé dans le logiciel. */
window.ACLIVE=(()=>{
  let sig='';
  try{localStorage.removeItem('fvfr_custom_aircraft');}catch(e){}
  const slug=s=>String(s).toUpperCase().replace(/[^A-Z0-9]+/g,'').slice(0,18);
  const notif=m=>{try{showNotif(m);}catch(e){}};

  // Code du modèle ATC de l'avion (par exemple DR400), nettoyé du préfixe MSFS
  function liveModel(){
    const L=window._msfsLive;
    return ((L&&L.info||{}).atc_model||'').replace(/^TT:ATCCOM\.AC_MODEL[_ ]?/i,'').replace(/\.\d+\.text$/i,'').trim();
  }
  // Noms servant à reconnaître l'avion (modèle puis titre MSFS), vide si aucun avion détecté
  function liveNames(){
    const L=window._msfsLive;
    return L&&L.title?[liveModel(),L.title].filter(Boolean):[];
  }
  function liveKey(){
    const L=window._msfsLive;
    if(!L||!L.title)return null;
    return 'AC_'+slug(liveModel()||L.title);
  }

  function build(title,info){
    const cruise=info.cruise_kt?Math.round(info.cruise_kt):100;
    const cap=info.fuel_cap_gal?Math.round(info.fuel_cap_gal*3.78541):100;
    const turbine=[1,3,5].includes(info.engine_type);
    const lph=Math.round(cruise*(turbine?0.75:0.3)*10)/10;   // estimation, remplacée par la mesure en vol
    const mtow=info.max_lb?Math.round(info.max_lb*0.45359):0;
    const empty=info.empty_lb?Math.round(info.empty_lb*0.45359):0;
    // Places : noms des stations si lisibles, sinon nombre de stations moins une station de bagages
    const seats=info.seats??(info.station_count>1?info.station_count-1:null);
    return {name:title.length>40?title.slice(0,39)+'…':title,cruise,
      range:Math.round(cap/lph*cruise*0.85/5)*5,
      pax:seats?Math.max(0,seats-1):1,roles:info.roles||null,
      minRwy:mtow?Math.round((250+mtow*0.12)/10)*10:400,
      icon:'🛩',multi:(info.engines||1)>1,
      fuelPerNm:Math.round(lph/cruise*100)/100,lph,fuelCap:cap,fuelType:turbine?'JET A-1':'AVGAS',
      emptyKg:empty,mtowKg:mtow,baggagePerPax:mtow?Math.min(15,Math.max(4,Math.round(mtow/100))):10,auto:true};
  }

  // Consommation réelle : débit carburant mesuré en vol (lissé)
  function learnBurn(L){
    const ac=AIRCRAFT[pilot.aircraft];
    if(!ac||!ac.auto||!(L.flowGph>0)||L.onGround!==false||!(L.spd>60))return;
    const m=L.flowGph*3.78541;
    ac.lph=Math.round((ac.lphMeasured?ac.lph*0.98+m*0.02:m)*10)/10;
    ac.lphMeasured=true;
    ac.fuelPerNm=Math.round(ac.lph/ac.cruise*100)/100;
  }

  // --- Volet « Données MSFS » : valeurs brutes reçues + profil retenu ---
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const flowText=L=>L&&L.flowGph>0?Math.round(L.flowGph*3.78541*10)/10+' L/h ('+Math.round(L.flowGph*10)/10+' gal/h)':'—';
  function renderDebug(){
    const body=document.getElementById('aircraft-debug-body');
    if(!body)return;
    const L=window._msfsLive;
    if(!L||!L.title){body.innerHTML='';return;}
    const i=L.info||{};
    const kg=lb=>lb==null?'—':Math.round(lb)+' lb = '+Math.round(lb*0.45359)+' kg';
    const rows=[
      ['Titre MSFS',esc(L.title)],
      ['Réservoir',i.fuel_cap_gal!=null?Math.round(i.fuel_cap_gal*10)/10+' gal = '+Math.round(i.fuel_cap_gal*3.78541)+' L':'—'],
      ['Masse à vide',kg(i.empty_lb)],
      ['Masse max',kg(i.max_lb)],
      ['Stations de charge',(i.stations&&i.stations.length)?i.stations.map((n,k)=>(k+1)+' : '+esc(n)+(i.roles?' ['+(i.roles[k]==='baggage'?'bagages':'siège')+']':'')).join('<br>'):'—'],
      ['Conso instantanée','<span id="acdbg-flow">'+flowText(L)+'</span>'],
    ];
    body.innerHTML='<table style="width:100%;font:10px \'DM Mono\',monospace;border-collapse:collapse;">'+rows.map(r=>`<tr><td style="padding:2px 6px 2px 0;color:var(--text3);vertical-align:top;white-space:nowrap;">${r[0]}</td><td style="padding:2px 0;">${r[1]}</td></tr>`).join('')+'</table>';
  }

  function autoSelect(){
    const L=window._msfsLive;
    if(!L||!L.title)return;
    const fe=document.getElementById('acdbg-flow');
    if(fe)fe.textContent=flowText(L);
    learnBurn(L);
    const info=L.info||{},s=L.title+'|'+(info.engines||0);
    if(s===sig)return;
    const key=liveKey();
    const missionKey=typeof activeMission!=='undefined'&&activeMission?(activeMission.aircraft||pilot.aircraft):null;
    if(missionKey&&missionKey!==key)return;   // autre avion pendant une mission : validateMissionAircraft avertit
    sig=s;
    AIRCRAFT[key]=build(L.title,info);
    const changed=key!==pilot.aircraft;
    pilot.aircraft=key;
    updateAircraftInfo();
    renderDebug();
    if(changed)notif('✈ Avion détecté : '+AIRCRAFT[key].name);
  }

  return {autoSelect,liveKey,liveNames,renderDebug,reset:()=>{sig='';}};
})();

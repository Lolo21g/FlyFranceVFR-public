/* FlyFranceVFR — Plan de vol VFR tracé sur la carte (indépendant des missions). */
window.FPL=(function(){
  const KEY='fvfr_flightplan';
  let wps=[],layer=null,panel=null,addMode=false,ready=false;
  const rad=x=>x*Math.PI/180;
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  const notif=m=>{try{showNotif(m);}catch(e){}};

  function dist(a,b){const h=Math.sin(rad(b.lat-a.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(b.lon-a.lon)/2)**2;return 3440.065*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));}
  function brg(a,b){const y=Math.sin(rad(b.lon-a.lon))*Math.cos(rad(b.lat));const x=Math.cos(rad(a.lat))*Math.sin(rad(b.lat))-Math.sin(rad(a.lat))*Math.cos(rad(b.lat))*Math.cos(rad(b.lon-a.lon));return (Math.atan2(y,x)*180/Math.PI+360)%360;}
  const p3=n=>String(Math.round(n)%360||360).padStart(3,'0');
  const hm=m=>{m=Math.round(m);return Math.floor(m/60)+'h'+String(m%60).padStart(2,'0');};
  function aircraft(){try{return AIRCRAFT[pilot.aircraft]||AIRCRAFT.DEFAULT;}catch(e){return {name:'',cruise:100};}}
  const deg=x=>x*180/Math.PI,norm=a=>((a%360)+360)%360;
  const num=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;

  function cleanAlt(v){
    const s=String(v||'').toUpperCase().replace(/\s+/g,'').replace(/FT$/,'');
    return /^(FL)?\d{1,5}$/.test(s)?s:'';
  }
  const altLabel=a=>!a?'':(/^FL/.test(a)?a:a+' ft');

  function setAlt(i,v){
    const a=cleanAlt(v);
    if(String(v).trim()&&!a)notif('Altitude invalide (ex. 2500 ou FL065)');
    wps[i].alt=a||undefined;
    persist();render();
  }

  function setName(i,v){
    const name = v.trim();
    wps[i].name = name;
    persist();render();
  }

  function conditions(){
    const d=typeof _lastSimData!=='undefined'?_lastSimData:null;
    const mv=d?num(d.magvar):null,ws=d?num(d.wind_speed):null,wd=d?num(d.wind_direction):null;
    return {magvar:mv,wind:ws!==null&&wd!==null?{dir:wd,speed:ws}:null};
  }

  function condText(c){
    const parts=[];
    if(c.wind)parts.push('vent MSFS '+p3(c.wind.dir)+'°/'+Math.round(c.wind.speed)+' kt');
    if(c.magvar!==null)parts.push('var. '+Math.abs(Math.round(c.magvar*10)/10)+'°'+(c.magvar>=0?'E':'W'));
    return parts.length?parts.join(' · '):'route vraie, sans vent (MSFS non connecté)';
  }

  function legNav(a,b){
    const c=conditions(),tas=aircraft().cruise||100,tc=brg(a,b),d=dist(a,b);
    let th=tc,gs=tas,wca=0;
    if(c.wind&&c.wind.speed>0){
      const rel=rad(c.wind.dir-tc),s=(c.wind.speed/tas)*Math.sin(rel);
      if(Math.abs(s)<1){
        const w=Math.asin(s);
        wca=deg(w);th=norm(tc+wca);
        gs=Math.max(tas*Math.cos(w)-c.wind.speed*Math.cos(rel),1);
      }
    }
    return {tc,th,wca,gs,dist:d,ete:d/gs*60,wind:!!c.wind,
      rm:c.magvar===null?null:norm(tc-c.magvar),cm:c.magvar===null?null:norm(th-c.magvar)};
  }

  function navData(){
    const c=conditions(),ac=aircraft(),legs=[];
    let cum=0,total=0;
    for(let i=1;i<wps.length;i++){
      const l=legNav(wps[i-1],wps[i]);
      cum+=l.ete;total+=l.dist;
      legs.push({...l,from:wps[i-1],to:wps[i],cum});
    }
    return {wps,legs,dist:total,ete:cum,tas:ac.cruise||100,ac,detected:!!(window._msfsLive&&window._msfsLive.title),cond:c,condText:condText(c)};
  }

  function navlog(){
    if(wps.length<2){notif('Ajoutez au moins 2 points au plan de vol');return;}
    NAVLOG.open();
  }

  function persist(){try{localStorage.setItem(KEY,JSON.stringify(wps));}catch(e){}try{save();}catch(e){}}

  function add(p){wps.push({name:p.name,lat:p.lat,lon:p.lon,icao:p.icao,alt:wps.length>1?wps[wps.length-1].alt:undefined});persist();render();}
  function addAirport(icao){
    icao=String(icao||'').trim().toUpperCase();
    const a=icao&&typeof airportByIcao==='function'?airportByIcao(icao):null;
    if(!a){notif('⚠ Aérodrome introuvable : '+(icao||'—'));return;}
    add({name:a.name+' ('+a.icao+')',lat:a.lat,lon:a.lon,icao:a.icao});
    if(panel)open();
  }
  function addIcao(){const i=document.getElementById('fpl-icao');if(!i)return;addAirport(i.value);i.value='';}
  function addAt(lat,lon){add({name:'',lat,lon});}
  function addFromContext(){if(!_ctxLatLng)return;const l=_ctxLatLng;closeMapContextMenu();addAt(l.lat,l.lng);open();}
  function insertAt(i,lat,lon){wps.splice(i,0,{name:'Point '+lat.toFixed(3)+', '+lon.toFixed(3),lat,lon,alt:wps[i].alt});map.closePopup();persist();render();}

  const BTN='display:block;box-sizing:border-box;margin-top:6px;width:100%;padding:5px;font-size:11px;cursor:pointer;border-radius:4px;font-family:monospace;';
  const BTN_PINK=BTN+'border:1px solid #ff7ad9;background:#3a1234;color:#ffb3ec;';
  const BTN_BLUE=BTN+'border:1px solid #4a9eff;background:#17345c;color:#d9eaff;';

  function legPopup(i,e){
    if(e.originalEvent)L.DomEvent.preventDefault(e.originalEvent);
    if(addMode){addAt(e.latlng.lat,e.latlng.lng);return;}
    try{closeMapContextMenu();}catch(x){}
    const l=legNav(wps[i-1],wps[i]);
    const route=l.rm!==null?`Route magnétique : <b>${p3(l.rm)}°</b> (vraie ${p3(l.tc)}°)`:`Route vraie : <b>${p3(l.tc)}°</b> (retour ${p3(brg(wps[i],wps[i-1]))}°)`;
    const cap=l.rm!==null&&l.wind?`<br>Cap à tenir : <b>${p3(l.cm)}°</b> (dérive ${l.wca>=0?'+':''}${Math.round(l.wca)}°)<br>Vitesse sol : <b>${Math.round(l.gs)} kt</b>`:'';
    const info=`<div style="font:11px 'DM Mono',monospace;line-height:1.6;min-width:200px;">${route}${cap}<br>Distance : <b>${l.dist.toFixed(1)} NM</b> · ${(l.dist*1.852).toFixed(1)} km<br>Durée : <b>${hm(l.ete)}</b>${wps[i].alt?`<br>Altitude : <b>${altLabel(wps[i].alt)}</b>`:''}</div>`;
    L.popup({offset:[0,-4]}).setLatLng(e.latlng).setContent(info+`<button style="${BTN_PINK}" onclick="FPL.insertAt(${i},${e.latlng.lat},${e.latlng.lng})">+ Insérer un point ici</button>`).openOn(map);
  }

  function airportNear(ll){
    const pt=map.latLngToContainerPoint(ll);
    let best=null,bd=22;
    (typeof markers!=='undefined'?markers:[]).forEach(mk=>{
      if(!mk.icao)return;
      const d=pt.distanceTo(map.latLngToContainerPoint(mk.getLatLng()));
      if(d<bd){bd=d;best=mk;}
    });
    return best;
  }

  function pointPopupHtml(i,icao){
    const a=icao&&typeof airportByIcao==='function'?airportByIcao(icao):null;
    const airport=icao?`<button style="${BTN_BLUE}" onclick="FPL.openAirport('${icao}')">✈ ${icao}${a?' — '+esc(a.name):''}</button>`:'';
    return `<div style="font-family:'DM Mono',monospace;min-width:200px;">${airport}<button style="${BTN_PINK}" onclick="FPL.remove(${i});map.closePopup();">🗑 Supprimer le point ${i+1}</button></div>`;
  }

  function openAirport(icao){
    map.closePopup();
    const mk=(typeof markers!=='undefined'?markers:[]).find(x=>x.icao===icao);
    if(mk)mk.fire('click');
  }

  function remove(i){wps.splice(i,1);persist();render();}
  function move(i,d){
    const j=i+d;if(j<0||j>=wps.length)return;
    const ai=wps[i].alt,aj=wps[j].alt;
    [wps[i],wps[j]]=[wps[j],wps[i]];
    wps[i].alt=ai;wps[j].alt=aj;
    persist();render();
  }
  function reverse(){
    const alts=wps.slice(1).map(p=>p.alt).reverse();
    wps.reverse();
    wps.forEach((p,k)=>{p.alt=k>0?alts[k-1]:undefined;});
    persist();render();
  }
  function clear(){
    if(!wps.length)return;
    const n=wps.length;
    confirmModal({
      title:'🗺 Effacer le plan de vol ?',
      message:`${n} point${n>1?'s':''} ser${n>1?'ont':'a'} supprim${n>1?'és':'é'}. Cette action est définitive.`,
      onConfirm:()=>{wps=[];persist();render();}
    });
  }
  function fit(){if(wps.length)map.fitBounds(L.latLngBounds(wps.map(p=>[p.lat,p.lon])),{padding:[70,70]});}

  function toggleAdd(){addMode=!addMode;map.getContainer().style.cursor=addMode?'crosshair':'';render();if(addMode)notif('Clique sur la carte pour poser un point');}

  function legLabel(a,b){
    const pa=map.latLngToContainerPoint([a.lat,a.lon]),pb=map.latLngToContainerPoint([b.lat,b.lon]);
    const fs=Math.max(9,Math.min(14,Math.round(map.getZoom())));
    const l=legNav(a,b);
    const text=p3(l.rm!==null?l.rm:l.tc)+'° · '+(l.dist<10?l.dist.toFixed(1):Math.round(l.dist))+' NM';
    if(text.length*(fs*0.6+0.3)>pa.distanceTo(pb)-26)return null;
    let ang=Math.atan2(pb.y-pa.y,pb.x-pa.x)*180/Math.PI;
    if(ang>90||ang<-90)ang+=180;
    const w=fs>=13?2:1.5,halo='#1a0b22';
    const shadow=[[-w,0],[w,0],[0,-w],[0,w],[-w,-w],[w,-w],[-w,w],[w,w]].map(o=>o[0]+'px '+o[1]+'px 0 '+halo).join(',');
    return {
      latlng:map.containerPointToLatLng(pa.add(pb).divideBy(2)),
      icon:L.divIcon({className:'',iconSize:[0,0],html:`<div style="position:absolute;left:0;top:0;width:max-content;transform:translate(-50%,-50%) rotate(${ang.toFixed(1)}deg);white-space:nowrap;color:#fff;font:800 ${fs}px 'DM Mono',monospace;letter-spacing:.3px;text-shadow:${shadow};">${text}</div>`})
    };
  }

  function render(){
    if(!ready)return;
    layer.clearLayers();
    if(wps.length>1)L.polyline(wps.map(p=>[p.lat,p.lon]),{pane:'fplPane',color:'#ff7ad9',weight:3,opacity:.95}).addTo(layer);
    for(let i=1;i<wps.length;i++){
      const a=wps[i-1],b=wps[i];
      L.polyline([[a.lat,a.lon],[b.lat,b.lon]],{pane:'fplPane',weight:12,opacity:0,bubblingMouseEvents:false}).addTo(layer)
        .on('contextmenu',e=>map.fire('contextmenu',e)).on('click',e=>legPopup(i,e));
      const label=legLabel(a,b);
      if(label)L.marker(label.latlng,{interactive:false,zIndexOffset:500,icon:label.icon}).addTo(layer);
    }
    wps.forEach((p,i)=>{
      const m=L.marker([p.lat,p.lon],{draggable:true,zIndexOffset:800,icon:L.divIcon({className:'',iconSize:[22,22],iconAnchor:[11,11],html:`<div style="width:22px;height:22px;border-radius:50%;background:#ff7ad9;color:#1a1030;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font:800 11px 'DM Mono',monospace;box-shadow:0 2px 6px rgba(0,0,0,.5);">${i+1}</div>`})}).addTo(layer);
      m.bindTooltip(esc(p.name),{direction:'top',offset:[0,-12]});
      m.on('click',()=>{
        const ap=airportNear(m.getLatLng());
        L.popup({closeButton:false,offset:[0,-10]}).setLatLng(m.getLatLng()).setContent(pointPopupHtml(i,ap&&ap.icao)).openOn(map);
      });
      m.on('dragend',e=>{const ll=e.target.getLatLng();p.lat=ll.lat;p.lon=ll.lng;if(!p.name||p.name==='Point '+p.lat.toFixed(3)+', '+p.lon.toFixed(3)){p.name='Point '+ll.lat.toFixed(3)+', '+ll.lng.toFixed(3);}delete p.icao;persist();render();});
    });
    renderList();
  }

  function renderList(){
    const box=document.getElementById('fpl-list');
    if(!box)return;
    const inp=document.getElementById('fpl-icao');
    if(inp)inp.placeholder=wps.length?'Étape ou arrivée (ICAO)':'Départ (ICAO, ex. LFBD)';
    const nav=navData();
    let h='';
    if(!wps.length)h='<div style="color:var(--text2,#8b95b0);font-size:11px;">Aucun point. Ajoute un ICAO ou clique sur la carte.</div>';
    wps.forEach((p,i)=>{
      let leg='';
      if(i>0){const l=nav.legs[i-1];leg=`<div style="display:flex;align-items:center;gap:6px;margin:2px 0 2px 16px;"><span style="flex:1;color:#ffb3ec;font-size:10px;">↑ ${l.rm!==null?'Rm'+p3(l.rm)+'° Cm'+p3(l.cm)+'°':'Rv '+p3(l.tc)+'°'} · ${l.dist.toFixed(1)} NM · ${hm(l.ete)}</span><input value="${esc(p.alt||'')}" placeholder="Alt./FL" title="Altitude (ft) ou niveau de vol retenu pour cette branche" onchange="FPL.setAlt(${i},this.value)" style="width:56px;font-size:10px;text-align:right;padding:1px 4px;"></div>`;}
      const b=(t,f,dis)=>`<span onclick="${f}" style="cursor:pointer;padding:0 4px;${dis?'opacity:.25;pointer-events:none;':''}">${t}</span>`;
      const nameVal = p.name||'Point '+p.lat.toFixed(3)+', '+p.lon.toFixed(3);
      h+=leg+`<div style="display:flex;align-items:center;gap:4px;font-size:11px;"><b style="color:#ff7ad9;width:14px;">${i+1}</b><input value="${esc(nameVal)}" placeholder="Nom du point" onchange="FPL.setName(${i},this.value)" style="flex:1;font-size:11px;background:transparent;border:1px solid var(--border);color:var(--text);padding:2px 4px;border-radius:3px;">${b('↑','FPL.move('+i+',-1)',i===0)}${b('↓','FPL.move('+i+',1)',i===wps.length-1)}${b('✕','FPL.remove('+i+')')}</div>`;
    });
    if(wps.length>1)h+=`<div style="border-top:1px solid var(--border,#2a3a5a);margin-top:8px;padding-top:6px;font-size:11px;"><b>Total : ${nav.dist.toFixed(1)} NM · ${hm(nav.ete)}</b><div style="color:var(--text2,#8b95b0);font-size:10px;">${esc(nav.ac.name||'Avion')} · ${nav.tas} kt · ${nav.condText}</div></div>`;
    box.innerHTML=h;
    const ab=document.getElementById('fpl-addbtn');
    if(ab){ab.style.background=addMode?'#4a1a44':'';ab.style.borderColor=addMode?'#ff7ad9':'';}
  }

  function open(){
    const asp=document.getElementById('asp-panel');if(asp)asp.style.display='none';
    panel.style.display='block';renderList();
    const b=document.getElementById('fpl-btn');if(b)b.style.borderColor='#ff7ad9';
  }
  function close(){
    panel.style.display='none';
    if(addMode){addMode=false;map.getContainer().style.cursor='';}
    const b=document.getElementById('fpl-btn');if(b)b.style.borderColor='';
  }
  function toggle(){panel.style.display==='block'?close():open();}

  function exportPlan(){return wps.map(p=>({name:p.name,lat:p.lat,lon:p.lon,icao:p.icao,alt:p.alt}));}
  function importPlan(a){
    if(!Array.isArray(a))return;
    wps=a.filter(p=>p&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lon))).map(p=>({name:String(p.name||'Point'),lat:Number(p.lat),lon:Number(p.lon),icao:p.icao,alt:cleanAlt(p.alt)||undefined}));
    try{localStorage.setItem(KEY,JSON.stringify(wps));}catch(e){}
    render();
  }

  function createMission(){
    if(!selectedAP){showNotif('⚠ Sélectionnez d’abord votre aérodrome de départ');return;}
    if(wps.length<3){showNotif('⚠ Ajoutez au moins 3 points au plan de vol (départ + waypoints + arrivée)');return;}
    if(!requirePilotWeight())return;
    if(activeMission){showNotif('⚠ Une mission est déjà en cours');return;}

    const ac=AIRCRAFT[pilot.aircraft]||AIRCRAFT.DEFAULT;
    let totalDist=0;
    for(let i=1;i<wps.length;i++){totalDist+=dist(wps[i-1],wps[i]);}
    totalDist=Math.round(totalDist);
    const missionDist=Math.max(6,totalDist*2);
    const dur=Math.max(8,Math.round((missionDist/(ac.cruise||100))*60)+5);
    const requestedPax=Math.max(1,Math.min(Number(ac.pax)||1,1+Math.floor(Math.random()*Math.max(1,Number(ac.pax)||1))));
    const load=buildCompatibleMissionPayload('Tourist',requestedPax,pilot.aircraft);
    if(!load){showNotif('⚠ Charge incompatible avec cet avion');return;}

    const m={
      id:'map-fpl-'+Date.now(),mapSelected:true,
      title:`Survol personnalisé de ${wps.slice(1,-1).length} points`,
      type:'Tourist',from:selectedAP.icao,poi:null,
      waypoints:wps.slice(1,-1),currentWaypointIndex:0,
      destPoint:{name:wps[wps.length-1].name,lat:wps[wps.length-1].lat,lon:wps[wps.length-1].lon},
      dist:missionDist,dur,pax:load.pax,
      payload:load.payload
    };
    addMapMissionAndAccept(m);
    close();
  }

  function init(){
    if(ready)return;
    map.createPane('fplPane').style.zIndex=450;
    layer=L.layerGroup().addTo(map);
    const host=document.getElementById('map-container')||map.getContainer();
    panel=document.createElement('div');
    panel.style.cssText='display:none;position:absolute;top:10px;right:54px;z-index:500;width:300px;max-height:75%;overflow-y:auto;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;box-shadow:0 4px 20px rgba(0,0,0,.4);';
    const btnCss='cursor:pointer;border:1px solid var(--border);border-radius:5px;padding:4px 7px;font-size:11px;background:transparent;color:var(--text);';
    panel.innerHTML=`<div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <b style="font-size:12px;">🗺 Plan de vol VFR</b>
      <span onclick="FPL.toggle()" style="cursor:pointer;">✕</span>
    </div>
    <div style="display:flex;gap:4px;margin-bottom:6px;">
      <input id="fpl-icao" placeholder="Départ (ICAO, ex. LFBD)" maxlength="4" style="flex:1;min-width:0;" onkeydown="if(event.key==='Enter')FPL.addIcao()">
      <button style="${btnCss}" onclick="FPL.addIcao()">+</button>
    </div>
    <button id="fpl-addbtn" style="${btnCss}width:100%;margin-bottom:8px;" onclick="FPL.toggleAdd()"><svg class="ico" aria-hidden="true"><use href="#ic-pin"/></svg> Poser des points sur la carte</button>
    <div id="fpl-list"></div>
    <button class="btn p" style="width:100%;margin-top:10px;" onclick="FPL.navlog()"><svg class="ico" aria-hidden="true"><use href="#ic-file"/></svg> Log de navigation</button>
    <button style="margin-top:6px;width:100%;padding:5px;font-size:11px;cursor:pointer;border:1px solid #34d399;border-radius:4px;background:#123b2a;color:#7fffd4;font-family:monospace;" onclick="FPL.createMission()"><svg class="ico" aria-hidden="true"><use href="#ic-target"/></svg> Créer mission</button>
    <div style="display:flex;gap:4px;margin-top:6px;">
      <button style="${btnCss}flex:1;" onclick="FPL.fit()">Voir</button>
      <button style="${btnCss}flex:1;" onclick="FPL.reverse()">Inverser</button>
      <button style="${btnCss}flex:1;" onclick="FPL.clear()">Effacer</button>
    </div>`;
    host.appendChild(panel);
    const col=document.querySelector('.mc2');
    if(col){
      const b=document.createElement('div');
      b.className='mb';
      b.id='fpl-btn';
      b.title='Plan de vol VFR';
      b.textContent='PLN';
      b.style.cssText="font-size:9px;font-family:'DM Mono',monospace;font-weight:800;";
      b.onclick=toggle;
      const about=col.querySelector('[title^="À propos"]');
      if(about)col.insertBefore(b,about);else col.appendChild(b);
    }
    map.on('click',e=>{if(addMode)addAt(e.latlng.lat,e.latlng.lng);});
    map.on('zoomend',render);
    ready=true;
    if(!wps.length){try{importPlan(JSON.parse(localStorage.getItem(KEY)||'[]'));}catch(e){}}
    render();
  }

  return {init,toggle,add,addAirport,addIcao,addAt,insertAt,addFromContext,openAirport,remove,move,reverse,clear,fit,toggleAdd,setAlt,setName,navData,navlog,export:exportPlan,import:importPlan,createMission};
})();
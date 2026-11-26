# FlyFranceVFR

FlyFranceVFR est un outil de préparation et d'assistance au vol VFR pour
Microsoft Flight Simulator : cartes aéronautiques interactives, planification
de navigation, radiocommunications, checklists et carnet de vol.

Il se compose de :

- **`bridge/`** — le « bridge » : une application Python (packagée avec
  PyInstaller pour la distribution) qui communique avec MSFS via SimConnect,
  sert l'interface web locale (`flyfrancevfr.html` et modules JS) et fournit
  les données OpenAIP (aérodromes, espaces aériens, navaids). La reconnaissance
  vocale des radiocommunications utilise Vosk (modèle français, téléchargé
  séparément).
- **`windows_app/`** — le lanceur Windows (.NET / WinForms + WebView2) et le
  script d'installation Inno Setup (`FlyFranceVFR_Inno.iss`).

## Téléchargement

Les installateurs Windows signés sont disponibles sur
[Rikoooo](https://www.rikoooo.com/) (page de téléchargement FlyFranceVFR).

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org)

- Committers and reviewers: *propriétaire du dépôt* (à remplacer par le lien de
  votre équipe/organisation une fois publiée)
- Approvers: *propriétaire du dépôt* (idem)
- Privacy policy: FlyFranceVFR fonctionne en local et ne transmet aucune donnée
  personnelle à des serveurs tiers ; les données OpenAIP sont téléchargées
  depuis openaip.net.

## Compilation

### Lanceur Windows (.NET)

```powershell
cd windows_app/FlyFranceVFR.Windows
dotnet publish -c Release -r win-x64 --self-contained
```

### Bridge (PyInstaller)

Les sources Python du bridge sont à la racine de `bridge/`
(`msfs_bridge_work.py`, `radio_recognizer.py`, `update_openaip_data.py`) et
dans `bridge/traffic_AI/`. Elles sont packagées en exécutable avec :

```powershell
pyinstaller --onefile --name FlyFranceVFR_Bridge msfs_bridge_work.py
```

### Installateur (Inno Setup)

Après avoir réuni le build du lanceur et du bridge dans `inno_package\`
(structure attendue : `FlyFranceVFR.exe` à la racine, `bridge\` à côté),
compiler avec Inno Setup 6 :

```powershell
ISCC.exe windows_app\FlyFranceVFR_Inno.iss
```

### Signature des binaires

La signature est effectuée via le service SignPath (voir
`windows_app\build_signe.ps1`) :

```powershell
.\windows_app\build_signe.ps1 -OrganizationId <guid> -ProjectSlug FlyFranceVFR `
    -SigningPolicySlug <politique> -ArtifactConfigurationSlug <config>
```

## Données

Les fichiers GeoJSON de `bridge/data/` (aérodromes, espaces, navaids…) sont
régénérables avec `update_openaip_data.py` à partir de l'API
[OpenAIP](https://www.openaip.net/). Les extraits officiels SIA (VAC) ne sont
pas redistribués dans ce dépôt.

## Licence

[Licence MIT](LICENSE) — © 2026 Laurent Gueyffier. Le logiciel est destiné à la
simulation de vol uniquement (voir l'avertissement en tête de fichier de
licence) et ne doit pas être utilisé pour la navigation réelle.

Composants tiers embarqués : Leaflet (BSD-2), polices DM Mono / Syne (SIL OFL),
modèle Vosk, Pillow et bibliothèques Python (détaillées dans les fichiers
adjacents le cas échéant).

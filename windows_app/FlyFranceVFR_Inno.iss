#define MyAppName "FlyFranceVFR"
#define MyAppVersion "0.7.5"
#define MyAppPublisher "FlyFranceVFR"
#define MyAppExeName "FlyFranceVFR.exe"

[Setup]
AppId={{0B8D975D-5D37-4E8B-92E5-FD5E560F5F56}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\FlyFranceVFR
DisableProgramGroupPage=yes
OutputDir=..\windows_app\inno_output
OutputBaseFilename=Setup_FlyFranceVFR_v0.7.5
SetupIconFile=assets\FlyFranceVFR.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
RestartApplications=no
DirExistsWarning=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "inno_package\*"; DestDir: "{app}"; Excludes: "bridge\bridge.log,bridge\flyfrancevfr_save.json"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
; Dossier des checklists PDF de l'avion (ajoutees par l'app ou copiees a la main)
Name: "{app}\bridge\aircraft\checklist"

[Icons]
Name: "{autoprograms}\FlyFranceVFR"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\FlyFranceVFR"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Executer FlyFranceVFR"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /F /T /IM FlyFranceVFR.exe >nul 2>&1"; Flags: runhidden waituntilterminated; RunOnceId: "StopFlyFranceVFR"
Filename: "{cmd}"; Parameters: "/C taskkill /F /T /IM FlyFranceVFR_Bridge.exe >nul 2>&1"; Flags: runhidden waituntilterminated; RunOnceId: "StopFlyFranceVFRBridge"

[UninstallDelete]
Type: files; Name: "{app}\bridge\bridge.log"
Type: filesandordirs; Name: "{app}\bridge"
Type: filesandordirs; Name: "{app}\WebView2"
Type: filesandordirs; Name: "{app}\runtimes"
Type: filesandordirs; Name: "{app}\data"
Type: dirifempty; Name: "{app}"

[Code]
var
  KeepUserSave: Boolean;

function SaveFileIfExists(Source, Dest: String): Boolean;
begin
  Result := False;
  if FileExists(Source) then
  begin
    ForceDirectories(ExtractFileDir(Dest));
    Result := CopyFile(Source, Dest, False);
  end;
end;

// Dossier de sauvegarde des donnees OpenAIP : DANS {app}\OpenAIP_Backup,
// cree uniquement si l'utilisateur choisit de garder sa progression (voir
// CurUninstallStepChanged). En cas de refus, {app} est entierement supprime
// a la fin de la desinstallation : aucune trace n'est laissee.
function GetOpenAipBackupDir(): String;
begin
  Result := ExpandConstant('{app}\OpenAIP_Backup');
end;

procedure BackupOpenAipData();
var
  Dest: String;
begin
  Dest := GetOpenAipBackupDir();
  ForceDirectories(Dest);
  SaveFileIfExists(ExpandConstant('{app}\bridge\data\fr_apt.geojson'), Dest + '\fr_apt.geojson');
  SaveFileIfExists(ExpandConstant('{app}\bridge\data\fr_asp.geojson'), Dest + '\fr_asp.geojson');
  SaveFileIfExists(ExpandConstant('{app}\bridge\data\fr_asp_vfr.geojson'), Dest + '\fr_asp_vfr.geojson');
  SaveFileIfExists(ExpandConstant('{app}\bridge\data\fr_nav.geojson'), Dest + '\fr_nav.geojson');
  SaveFileIfExists(ExpandConstant('{app}\bridge\data\fr_rpp.geojson'), Dest + '\fr_rpp.geojson');
  SaveFileIfExists(ExpandConstant('{app}\bridge\data\fr_obs.geojson'), Dest + '\fr_obs.geojson');
  SaveFileIfExists(ExpandConstant('{app}\bridge\data\fr_freqs.json'), Dest + '\fr_freqs.json');
end;

procedure RestoreOpenAipData();
var
  Src: String;
begin
  Src := GetOpenAipBackupDir();
  if not DirExists(Src) then
    Exit;
  // Le backup n'existe que si l'utilisateur a choisi "Oui" a la desinstallation
  // precedente : on l'ecrase donc systematiquement par-dessus les fichiers
  // geojson livres avec l'installeur (qui seraient sinon plus anciens que
  // ceux sauvegardes et empecheraient la restauration).
  ForceDirectories(ExpandConstant('{app}\bridge\data'));
  SaveFileIfExists(Src + '\fr_apt.geojson', ExpandConstant('{app}\bridge\data\fr_apt.geojson'));
  SaveFileIfExists(Src + '\fr_asp.geojson', ExpandConstant('{app}\bridge\data\fr_asp.geojson'));
  SaveFileIfExists(Src + '\fr_asp_vfr.geojson', ExpandConstant('{app}\bridge\data\fr_asp_vfr.geojson'));
  SaveFileIfExists(Src + '\fr_nav.geojson', ExpandConstant('{app}\bridge\data\fr_nav.geojson'));
  SaveFileIfExists(Src + '\fr_rpp.geojson', ExpandConstant('{app}\bridge\data\fr_rpp.geojson'));
  SaveFileIfExists(Src + '\fr_obs.geojson', ExpandConstant('{app}\bridge\data\fr_obs.geojson'));
  SaveFileIfExists(Src + '\fr_freqs.json', ExpandConstant('{app}\bridge\data\fr_freqs.json'));

  // Le backup a rempli son role (donnees restaurees) : on le supprime pour
  // ne pas laisser de dossier residuel inutile.
  DelTree(Src, True, True, True);
end;

// Copie tous les PDF d'un dossier vers un autre (ecrase les fichiers de meme nom)
procedure CopyPdfFiles(Src, Dest: String);
var
  FindRec: TFindRec;
begin
  if not DirExists(Src) then
    Exit;
  ForceDirectories(Dest);
  if FindFirst(Src + '\*.pdf', FindRec) then
  begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then
          CopyFile(Src + '\' + FindRec.Name, Dest + '\' + FindRec.Name, False);
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

// Checklists de l'avion : sauvegardees (comme les donnees OpenAIP) si l'utilisateur garde sa progression
procedure BackupChecklists();
begin
  CopyPdfFiles(ExpandConstant('{app}\bridge\aircraft\checklist'), ExpandConstant('{app}\Sauvegarde\checklist'));
end;

// Restauration par-dessus les fichiers livres, puis suppression de la sauvegarde pour qu'une
// simple mise a jour ne remplace jamais des checklists plus recentes par d'anciennes.
procedure RestoreChecklists();
var
  Src: String;
begin
  Src := ExpandConstant('{app}\Sauvegarde\checklist');
  if not DirExists(Src) then
    Exit;
  CopyPdfFiles(Src, ExpandConstant('{app}\bridge\aircraft\checklist'));
  DelTree(Src, True, True, True);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  BackupDir: String;
  KeepSave: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    KeepSave := MsgBox(
      'Voulez-vous conserver votre profil pilote, votre carnet de vol, vos POI et vos checklists pour une prochaine installation ?',
      mbConfirmation,
      MB_YESNO);

    if KeepSave = IDYES then
    begin
      KeepUserSave := True;

      // Donnees OpenAIP (aerodromes/espaces/navaids/...) : sauvegardees
      // uniquement si l'utilisateur garde sa progression. En cas de refus,
      // on ne laisse aucune trace.
      BackupOpenAipData();
      BackupChecklists();

      BackupDir := ExpandConstant('{app}\Sauvegarde');
      ForceDirectories(BackupDir);
      SaveFileIfExists(ExpandConstant('{app}\bridge\flyfrancevfr_save.json'), BackupDir + '\flyfrancevfr_save.json');
      SaveFileIfExists(ExpandConstant('{app}\bridge\flyfrance_save.json'), BackupDir + '\flyfrance_save.json');
      SaveStringToFile(
        BackupDir + '\LISEZ-MOI.txt',
        'Sauvegarde conservee par le desinstallateur FlyFranceVFR.' + #13#10 +
        'Elle sera restauree automatiquement a la prochaine installation.' + #13#10,
        False);
    end;
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    if not KeepUserSave then
      DelTree(ExpandConstant('{app}'), True, True, True);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  BackupDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    BackupDir := ExpandConstant('{app}\Sauvegarde');
    { Ne restaurer la sauvegarde conservée que si aucune sauvegarde active
      n'existe. Lors d'une mise à jour par-dessus l'installation actuelle,
      cela empêche une ancienne sauvegarde de remplacer la progression récente. }
    if FileExists(BackupDir + '\flyfrancevfr_save.json') and
       not FileExists(ExpandConstant('{app}\bridge\flyfrancevfr_save.json')) then
    begin
      ForceDirectories(ExpandConstant('{app}\bridge'));
      SaveFileIfExists(BackupDir + '\flyfrancevfr_save.json', ExpandConstant('{app}\bridge\flyfrancevfr_save.json'));
    end;
    if FileExists(BackupDir + '\flyfrance_save.json') and
       not FileExists(ExpandConstant('{app}\bridge\flyfrance_save.json')) then
    begin
      ForceDirectories(ExpandConstant('{app}\bridge'));
      SaveFileIfExists(BackupDir + '\flyfrance_save.json', ExpandConstant('{app}\bridge\flyfrance_save.json'));
    end;

    RestoreOpenAipData();
    RestoreChecklists();
  end;
end;

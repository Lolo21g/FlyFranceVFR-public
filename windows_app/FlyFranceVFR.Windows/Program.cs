using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace FlyFranceVFR.Windows
{
    internal static class Program
    {
        private const string AppMutexName = "FlyFranceVFR.Windows.SingleInstance";

        [STAThread]
        private static void Main()
        {
            using (var mutex = new Mutex(true, AppMutexName, out var isFirstInstance))
            {
                if (!isFirstInstance)
                {
                    MessageBox.Show(
                        "FlyFranceVFR est deja ouvert.",
                        "FlyFranceVFR",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new FlyFranceForm());
            }
        }
    }

    internal sealed class FlyFranceForm : Form
    {
        private readonly WebView2 _webView;
        private Process _bridgeProcess;
        private bool _allowClose;
        private readonly System.Windows.Forms.Timer _altTabTimer;
        private bool _altTabPressed;
        private bool _backgroundAllowedByAltTab;
        private const int VkMenu = 0x12;
        private const int VkTab = 0x09;
        private readonly string _appUrl = "http://127.0.0.1:8080/flyfrancevfr.html";
        private readonly string _webViewDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "FlyFranceVFR",
            "WebView2");

        public FlyFranceForm()
        {
            Text = "FlyFranceVFR";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1100, 720);
            Width = 1366;
            Height = 820;
            // FlyFranceVFR reste au premier plan en permanence. Seul Alt+Tab
            // libere temporairement ce verrou pour permettre le changement
            // d'application.
            TopMost = true;
            BackColor = Color.FromArgb(11, 15, 23);
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(11, 15, 23)
            };

            Controls.Add(_webView);

            _altTabTimer = new System.Windows.Forms.Timer { Interval = 20 };
            _altTabTimer.Tick += DetectAltTab;
            _altTabTimer.Start();

            Load += async (_, __) => await StartAsync();
            Shown += (_, __) => KeepInFront();
            Activated += (_, __) => RestoreTopMostAfterAltTab();
            FormClosing += OnFormClosing;
        }

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int virtualKey);

        private static bool IsKeyDown(int virtualKey)
        {
            return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
        }

        private void DetectAltTab(object sender, EventArgs e)
        {
            var pressed = IsKeyDown(VkMenu) && IsKeyDown(VkTab);
            if (pressed && !_altTabPressed)
            {
                _altTabPressed = true;
                _backgroundAllowedByAltTab = true;
                TopMost = false;
            }
            else if (!pressed)
            {
                _altTabPressed = false;
            }
        }

        private void KeepInFront()
        {
            if (IsDisposed)
            {
                return;
            }

            TopMost = true;
            BringToFront();
            Activate();
        }

        private void RestoreTopMostAfterAltTab()
        {
            if (!_backgroundAllowedByAltTab || IsDisposed)
            {
                return;
            }

            _backgroundAllowedByAltTab = false;
            TopMost = true;
        }

        private async Task StartAsync()
        {
            try
            {
                await EnsureBridgeAsync();
                Directory.CreateDirectory(_webViewDataDir);
                var environment = await CreateWebView2EnvironmentWithRetryAsync();
                await _webView.EnsureCoreWebView2Async(environment);
                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                _webView.CoreWebView2.Settings.AreHostObjectsAllowed = false;
                _webView.CoreWebView2.Settings.IsWebMessageEnabled = true;
                _webView.CoreWebView2.PermissionRequested += (_, args) =>
                {
                    if (args.PermissionKind == CoreWebView2PermissionKind.Microphone)
                    {
                        args.State = CoreWebView2PermissionState.Allow;
                        args.Handled = true;
                    }
                };
                _webView.CoreWebView2.WebMessageReceived += (_, args) =>
                {
                    var message = args.TryGetWebMessageAsString();
                    if (message == "shutdown-confirmed")
                    {
                        _allowClose = true;
                        Close();
                    }
                    else if (message != null && message.StartsWith("set-default-microphone:", StringComparison.Ordinal))
                    {
                        var encodedLabel = message.Substring("set-default-microphone:".Length);
                        var label = Uri.UnescapeDataString(encodedLabel);
                        var success = AudioEndpointManager.SetDefaultCaptureDevice(label);
                        _webView.CoreWebView2.PostWebMessageAsString(
                            "microphone-default-result:" +
                            (success ? "ok:" : "error:") +
                            Uri.EscapeDataString(label));
                    }
                };
                _webView.CoreWebView2.NewWindowRequested += (_, args) =>
                {
                    args.Handled = true;
                };
                _webView.CoreWebView2.NavigationStarting += (_, args) =>
                {
                    if (!IsAllowedAppUri(args.Uri))
                    {
                        args.Cancel = true;
                    }
                };
                _webView.Source = new Uri(_appUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Impossible de demarrer FlyFranceVFR.\n\n" + ex.Message,
                    "FlyFranceVFR",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                // On ne laisse pas la fenetre a moitie initialisee ouverte : sans ca,
                // l'utilisateur doit parfois forcer la fermeture (Gestionnaire des taches),
                // ce qui recree exactement le meme profil WebView2 verrouille au prochain
                // lancement et perpetue le probleme (micro/joystick a reapprendre).
                _allowClose = true;
                StopBridgeIfStarted();
                Close();
            }
        }

        // Au tout premier lancement (notamment si un antivirus scanne l'executable
        // ou le bridge a ce moment-la), un lancement precedent peut se terminer de
        // facon anormale et laisser le dossier de profil WebView2 momentanement
        // verrouille. CoreWebView2Environment.CreateAsync echoue alors immediatement
        // au lancement suivant. On retente quelques fois avec une courte pause : le
        // verrou se libere generalement de lui-meme en 1 a 2 secondes.
        private async Task<CoreWebView2Environment> CreateWebView2EnvironmentWithRetryAsync()
        {
            const int maxAttempts = 5;
            var delay = TimeSpan.FromMilliseconds(800);
            Exception lastError = null;

            for (var attempt = 1; attempt <= maxAttempts; attempt++)
            {
                try
                {
                    return await CoreWebView2Environment.CreateAsync(null, _webViewDataDir);
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    if (attempt < maxAttempts)
                    {
                        await Task.Delay(delay);
                        delay += delay; // backoff progressif : 0.8s, 1.6s, 3.2s, 6.4s
                    }
                }
            }

            throw new InvalidOperationException(
                "Le profil WebView2 est reste verrouille apres plusieurs tentatives " +
                "(souvent du a un premier lancement interrompu, par ex. par un scan antivirus). " +
                "Fermez tout processus FlyFranceVFR encore actif dans le Gestionnaire des taches, " +
                "puis relancez l'application.",
                lastError);
        }

        private async void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!_allowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                await ShowQuitConfirmAsync();
                return;
            }

            _altTabTimer.Stop();
            StopBridgeIfStarted();
        }

        private async Task ShowQuitConfirmAsync()
        {
            try
            {
                if (_webView.CoreWebView2 != null)
                {
                    await _webView.CoreWebView2.ExecuteScriptAsync(
                        "if(typeof showQuitConfirm==='function'){showQuitConfirm();}");
                    return;
                }
            }
            catch
            {
            }

            var result = MessageBox.Show(
                "Voulez-vous fermer FlyFranceVFR et arreter le pont MSFS ?",
                "Quitter FlyFranceVFR",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);
            if (result == DialogResult.Yes)
            {
                _allowClose = true;
                Close();
            }
        }

        private async Task EnsureBridgeAsync()
        {
            if (await IsServerReadyAsync())
            {
                return;
            }

            var bridgePath = await WaitForBridgePathAsync();
            if (bridgePath == null)
            {
                throw new FileNotFoundException(
                    "Le pont MSFS est introuvable.\n\n" +
                    "Si Avast vient d'analyser FlyFranceVFR, attendez la fin de l'analyse puis relancez l'application.");
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = bridgePath,
                WorkingDirectory = Path.GetDirectoryName(bridgePath),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            startInfo.EnvironmentVariables["FLYFRANCEVFR_NO_BROWSER"] = "1";
            _bridgeProcess = Process.Start(startInfo);

            var deadline = DateTime.UtcNow.AddSeconds(45);
            while (DateTime.UtcNow < deadline)
            {
                if (await IsServerReadyAsync())
                {
                    return;
                }

                await Task.Delay(500);
            }

            throw new TimeoutException("Le bridge local ne repond pas sur le port 8080.");
        }

        private static async Task<string> WaitForBridgePathAsync()
        {
            var deadline = DateTime.UtcNow.AddSeconds(90);
            while (DateTime.UtcNow < deadline)
            {
                var bridgePath = FindBridgePath();
                if (bridgePath != null)
                {
                    return bridgePath;
                }

                await Task.Delay(1000);
            }

            return null;
        }

        private async Task<bool> IsServerReadyAsync()
        {
            try
            {
                using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) })
                using (var response = await client.GetAsync(_appUrl))
                {
                    return response.IsSuccessStatusCode;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool IsAllowedAppUri(string uri)
        {
            if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
            {
                return false;
            }

            if (!string.Equals(parsed.Scheme, "http", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var hostAllowed =
                string.Equals(parsed.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(parsed.Host, "localhost", StringComparison.OrdinalIgnoreCase);

            return hostAllowed && parsed.Port == 8080;
        }

        private static string FindBridgePath()
        {
            var appDir = Path.GetDirectoryName(Application.ExecutablePath) ?? AppDomain.CurrentDomain.BaseDirectory;
            var localAppDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "FlyFranceVFR");
            var runtimeDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "FlyFranceVFR",
                "runtime");
            var registeredDir = GetRegisteredInstallDir();
            var candidates = new[]
            {
                Path.Combine(appDir, "bridge", "FlyFranceVFR_Bridge.exe"),
                Path.Combine(appDir, "FlyFranceVFR_Bridge.exe"),
                Path.Combine(registeredDir ?? "", "bridge", "FlyFranceVFR_Bridge.exe"),
                Path.Combine(registeredDir ?? "", "FlyFranceVFR_Bridge.exe"),
                Path.Combine(localAppDir, "bridge", "FlyFranceVFR_Bridge.exe"),
                Path.Combine(localAppDir, "FlyFranceVFR_Bridge.exe"),
                Path.Combine(runtimeDir, "bridge", "FlyFranceVFR_Bridge.exe"),
                Path.Combine(runtimeDir, "FlyFranceVFR_Bridge.exe")
            };

            foreach (var candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            return null;
        }

        private static string GetRegisteredInstallDir()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\FlyFranceVFR"))
                {
                    return key?.GetValue("InstallLocation") as string;
                }
            }
            catch
            {
                return null;
            }
        }

        private void StopBridgeIfStarted()
        {
            try
            {
                if (_bridgeProcess != null && !_bridgeProcess.HasExited)
                {
                    _bridgeProcess.CloseMainWindow();
                    if (!_bridgeProcess.WaitForExit(1500))
                    {
                        _bridgeProcess.Kill();
                    }
                }
            }
            catch
            {
                // The bridge may already be closed by Windows or by the user.
            }
        }
    }

    internal static class AudioEndpointManager
    {
        private const string CaptureRegistryPath =
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture";
        private const string FriendlyNameProperty =
            "{a45c254e-df1c-4efd-8020-67d146a850e0},2";
        private const string InterfaceNameProperty =
            "{b3f8fa53-0004-438e-9003-51a46e139bfc},6";

        internal static bool SetDefaultCaptureDevice(string requestedLabel)
        {
            if (string.IsNullOrWhiteSpace(requestedLabel))
            {
                return false;
            }

            string endpointId = null;
            try
            {
                using (var root = Registry.LocalMachine.OpenSubKey(CaptureRegistryPath))
                {
                    if (root == null)
                    {
                        return false;
                    }

                    foreach (var subKeyName in root.GetSubKeyNames())
                    {
                        using (var endpoint = root.OpenSubKey(subKeyName))
                        using (var properties = endpoint?.OpenSubKey("Properties"))
                        {
                            var state = Convert.ToInt32(endpoint?.GetValue("DeviceState") ?? 0);
                            if (state != 1 || properties == null)
                            {
                                continue;
                            }

                            var friendly = properties.GetValue(FriendlyNameProperty) as string ?? "";
                            var interfaceName = properties.GetValue(InterfaceNameProperty) as string ?? "";
                            var fullLabel = string.IsNullOrWhiteSpace(interfaceName)
                                ? friendly
                                : friendly + " (" + interfaceName + ")";

                            if (string.Equals(fullLabel, requestedLabel, StringComparison.OrdinalIgnoreCase) ||
                                string.Equals(friendly, requestedLabel, StringComparison.OrdinalIgnoreCase))
                            {
                                endpointId = "{0.0.1.00000000}." + subKeyName;
                                break;
                            }
                        }
                    }
                }

                if (endpointId == null)
                {
                    return false;
                }

                var policy = (IPolicyConfig)new PolicyConfigClient();
                try
                {
                    // Applique le choix à tous les rôles Windows afin que Web Speech
                    // et les autres applications voient immédiatement le même micro.
                    policy.SetDefaultEndpoint(endpointId, ERole.Console);
                    policy.SetDefaultEndpoint(endpointId, ERole.Multimedia);
                    policy.SetDefaultEndpoint(endpointId, ERole.Communications);
                    return true;
                }
                finally
                {
                    if (Marshal.IsComObject(policy))
                    {
                        Marshal.FinalReleaseComObject(policy);
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private enum ERole
        {
            Console = 0,
            Multimedia = 1,
            Communications = 2
        }

        [ComImport]
        [Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
        private class PolicyConfigClient
        {
        }

        [ComImport]
        [Guid("F8679F50-850A-41CF-9C72-430F290290C8")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPolicyConfig
        {
            int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr format);
            int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int isDefault, IntPtr format);
            int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
            int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
            int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int isDefault, IntPtr defaultPeriod, IntPtr minimumPeriod);
            int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr period);
            int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
            int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
            int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr key, IntPtr value);
            int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr key, IntPtr value);

            [PreserveSig]
            int SetDefaultEndpoint(
                [MarshalAs(UnmanagedType.LPWStr)] string deviceId,
                ERole role);

            int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int visible);
        }
    }
}

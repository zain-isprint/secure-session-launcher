// Secure Session Helper (experimental): opens applications in isolated browser profiles for Secure Session Launcher.
//
// One program, two roles:
//  - Native messaging host (started by Chrome): length-prefixed JSON on stdin/stdout.
//      { action: "ping" }                         -> { ok, version }
//      { action: "open", url, portal, browser, waitFor }
//                                                 -> { ok, session }  starts an isolated session (second role) in the
//                                                     same browser as the launcher: "chrome" (default) or "edge";
//                                                     waitFor "uso": first wait until the USO Chrome extension is active
//      { action: "closeSessions", portal }        -> { ok, closed, forced }  at the portal's sign-out
//      { action: "closeSession", sessions: [id] } -> { ok, closed, forced }  "Close active session & continue"
//      { action: "list" }                         -> { ok, sessions: [id] }  the sessions whose windows are still open
//      { action: "watch" } (long-lived port)      -> { event: "focused", session } / { event: "browserFront", name }
//  - Isolated session (started by the first role): SecureSessionHelper.exe --isolated <url> <portal> <session> <browser> <wait>
//      picks a reusable isolated profile not in use (%LOCALAPPDATA%\SecureSessionLauncher\profiles\parallel-N),
//      deletes its sign-in data (keeps extensions) and opens the browser on the application; with wait "uso", on a
//      setup page on 127.0.0.1 that waits for the USO Chrome extension first and then goes to the application.
// Extensions reach the isolated profiles through Chrome's own routes (normally: force-installed by policy).
//
// Build (no SDK needed): %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe
//   /r:System.Web.Extensions.dll /out:SecureSessionHelper.exe SecureSessionHelper.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class SecureSessionHelper {
    const string Version = "0.5.0";
    const string UsoId = "bfffjeneelooklefkmdigdfpnpfnfeac";
    static readonly string Base = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SecureSessionLauncher");
    static readonly string SessionsFile = Path.Combine(Base, "isolated-sessions.json");
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutLock = new object();
    static Stream stdout;

    static readonly string[] SignInData = { "Cookies", "Cookies-journal", @"Network\Cookies", @"Network\Cookies-journal", "Local Storage",
        "Session Storage", "IndexedDB", "Service Worker", "Cache", "Code Cache", "Web Data", "Web Data-journal", "Login Data",
        "Login Data-journal", "Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs" };

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    static void Log(string file, string text) {
        try { Directory.CreateDirectory(Base); File.AppendAllText(Path.Combine(Base, file), DateTime.UtcNow.ToString("o") + " " + text + Environment.NewLine); }
        catch { }
    }

    [STAThread]
    static int Main(string[] args) {
        Directory.CreateDirectory(Base);
        if (args.Length >= 2 && args[0] == "--isolated")
            return Isolated(args[1], args.Length > 2 ? args[2] : "", args.Length > 3 ? args[3] : "", args.Length > 4 ? args[4] : "chrome",
                            args.Length > 5 && args[5] == "uso");
        return Host(args);
    }

    // ---------------------------------------------------------------- native messaging host
    static int Host(string[] args) {
        Log("host.log", "host started by " + string.Join(" ", args));
        var stdin = Console.OpenStandardInput();
        stdout = Console.OpenStandardOutput();
        var head = new byte[4];
        while (true) {
            if (!ReadExactly(stdin, head, 4)) break;
            int len = BitConverter.ToInt32(head, 0);
            if (len <= 0 || len > 1024 * 1024) break;
            var body = new byte[len];
            if (!ReadExactly(stdin, body, len)) break;
            object reply;
            try { reply = Handle(Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body))); }
            catch (Exception e) { reply = new Dictionary<string, object> { { "ok", false }, { "error", e.Message } }; Log("host.log", "error " + e); }
            Send(reply);
        }
        return 0;
    }

    static bool ReadExactly(Stream s, byte[] buf, int n) {
        int got = 0;
        while (got < n) { int r = s.Read(buf, got, n - got); if (r <= 0) return false; got += r; }
        return true;
    }

    static void Send(object message) {
        var body = Encoding.UTF8.GetBytes(Json.Serialize(message));
        lock (OutLock) { stdout.Write(BitConverter.GetBytes(body.Length), 0, 4); stdout.Write(body, 0, body.Length); stdout.Flush(); }
    }

    static string Str(Dictionary<string, object> m, string key) { object v; return m != null && m.TryGetValue(key, out v) && v is string ? (string)v : null; }

    static object Handle(Dictionary<string, object> msg) {
        string action = Str(msg, "action");
        if (action == "ping") return new Dictionary<string, object> { { "ok", true }, { "version", Version } };
        if (action == "open") {
            Uri url;
            if (!Uri.TryCreate(Str(msg, "url") ?? "", UriKind.Absolute, out url) || (url.Scheme != "https" && url.Scheme != "http"))
                return new Dictionary<string, object> { { "ok", false }, { "error", "Only http and https URLs can be opened." } };
            string portal = Str(msg, "portal") ?? "";
            Uri p;
            if (portal != "" && !(Uri.TryCreate(portal, UriKind.Absolute, out p) && p.AbsolutePath == "/" && portal.TrimEnd('/') == p.GetLeftPart(UriPartial.Authority))) portal = "";
            string browser = Str(msg, "browser") == "edge" ? "edge" : "chrome";
            if (BrowserPath(browser) == null)   // say so now: the launcher shows the error instead of nothing happening
                return new Dictionary<string, object> { { "ok", false }, { "error", (browser == "edge" ? "Microsoft Edge" : "Google Chrome") + " was not found on this PC." } };
            string wait = Str(msg, "waitFor") == "uso" ? "uso" : "none";
            string session = Guid.NewGuid().ToString("N").Substring(0, 12);
            var psi = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName) { UseShellExecute = false, CreateNoWindow = true };
            psi.Arguments = "--isolated " + Quote(url.AbsoluteUri) + " " + Quote(portal == "" ? "-" : portal) + " " + session + " " + browser + " " + wait;
            var child = Process.Start(psi);
            Log("host.log", "open " + session + " " + browser + " " + url.AbsoluteUri + " pid " + child.Id);
            return new Dictionary<string, object> { { "ok", true }, { "session", session }, { "mode", "persistent" } };
        }
        if (action == "closeSessions") return CloseSessions(Str(msg, "portal"));
        if (action == "closeSession") return CloseSession(msg);
        if (action == "list") return ListSessions();
        if (action == "watch") { StartWatching(); return new Dictionary<string, object> { { "ok", true }, { "watching", true } }; }
        return new Dictionary<string, object> { { "ok", false }, { "error", "Unknown action." } };
    }

    static string Quote(string s) { return "\"" + s.Replace("\"", "") + "\""; }

    // ---------------------------------------------------------------- sessions list
    class Session { public int pid; public string dir; public string portal; public string session; public string started; }

    static List<Session> ReadSessions() {
        try { return Json.Deserialize<List<Session>>(File.ReadAllText(SessionsFile)) ?? new List<Session>(); } catch { return new List<Session>(); }
    }
    static void WriteSessions(List<Session> list) { File.WriteAllText(SessionsFile, Json.Serialize(list)); }

    static bool Alive(int pid) {
        try { var p = Process.GetProcessById(pid); return !p.HasExited; } catch { return false; }
    }

    // ---------------------------------------------------------------- open sessions
    static object ListSessions() {
        var live = ReadSessions().Where(s => Alive(s.pid) && !string.IsNullOrEmpty(s.session)).Select(s => (object)s.session).ToList();
        return new Dictionary<string, object> { { "ok", true }, { "sessions", live } };
    }

    // ---------------------------------------------------------------- closing (sign-out, or "Close active session")
    static object CloseSessions(string portal) {
        return Close(s => portal == null || s.portal == portal, "closeSessions " + (portal ?? "(all)"));
    }

    static object CloseSession(Dictionary<string, object> msg) {
        object v;
        var ids = new HashSet<string>((msg.TryGetValue("sessions", out v) && v is System.Collections.IEnumerable && !(v is string)
            ? ((System.Collections.IEnumerable)v).OfType<string>() : Enumerable.Empty<string>()));
        if (ids.Count == 0) return new Dictionary<string, object> { { "ok", false }, { "error", "No sessions given." } };
        return Close(s => s.session != null && ids.Contains(s.session), "closeSession");
    }

    static object Close(Func<Session, bool> which, string label) {
        var list = ReadSessions();
        var mine = list.Where(which).ToList();
        int closed = 0, forced = 0;
        foreach (var s in mine) {
            if (Alive(s.pid)) {
                RunHidden("taskkill", "/PID " + s.pid);                          // polite: asks the windows to close
                for (int i = 0; i < 16 && Alive(s.pid); i++) Thread.Sleep(500);
                if (Alive(s.pid)) { RunHidden("taskkill", "/PID " + s.pid + " /T /F"); forced++; Thread.Sleep(1500); }
                closed++;
            }
            int removed = ClearSignInData(s.dir);
            Log("host.log", label + " pid " + s.pid + (Alive(s.pid) ? " STILL RUNNING" : " closed") + " cleared " + removed + " sign-in stores");
        }
        WriteSessions(list.Where(s => !mine.Contains(s) && Alive(s.pid)).ToList());
        return new Dictionary<string, object> { { "ok", true }, { "closed", closed }, { "forced", forced } };
    }

    static void RunHidden(string exe, string arguments) {
        try { using (var p = Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = false, CreateNoWindow = true })) p.WaitForExit(5000); } catch { }
    }

    static int ClearSignInData(string dir) {
        int removed = 0;
        foreach (var rel in SignInData) {
            string p = Path.Combine(dir, "Default", rel);
            try {
                if (Directory.Exists(p)) { Directory.Delete(p, true); removed++; }
                else if (File.Exists(p)) { File.Delete(p); removed++; }
            } catch { }
        }
        return removed;
    }

    // ---------------------------------------------------------------- watching the window in front
    static Thread watcher;
    static void StartWatching() {
        if (watcher != null) return;
        watcher = new Thread(() => {
            uint last = 0;
            while (true) {
                uint pid;
                GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                if (pid != 0 && pid != last) {
                    last = pid;
                    var s = ReadSessions().FirstOrDefault(x => x.pid == (int)pid && !string.IsNullOrEmpty(x.session));
                    if (s != null) { Send(new Dictionary<string, object> { { "event", "focused" }, { "session", s.session } }); Log("host.log", "focused " + s.session + " pid " + pid); }
                    else {
                        string name = "";
                        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
                        // A normal browser window back in front: the launcher in that browser reports its window again
                        // (the browser may not have noticed losing focus to the separate window).
                        if (name.Equals("chrome", StringComparison.OrdinalIgnoreCase) || name.Equals("msedge", StringComparison.OrdinalIgnoreCase))
                            Send(new Dictionary<string, object> { { "event", "browserFront" }, { "name", name.ToLowerInvariant() } });
                    }
                }
                Thread.Sleep(150);
            }
        }) { IsBackground = true };
        watcher.Start();
        Log("host.log", "watching the foreground window");
    }

    // ---------------------------------------------------------------- isolated session
    // The browser's program: from Windows' "App Paths" registration, else its usual install folders.
    static string BrowserPath(string browser) {
        string exeName = browser == "edge" ? "msedge.exe" : "chrome.exe";
        string folder = browser == "edge" ? @"Microsoft\Edge\Application" : @"Google\Chrome\Application";
        foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser }) {
            using (var k = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exeName)) {
                var v = k == null ? null : k.GetValue("") as string;
                if (!string.IsNullOrEmpty(v) && File.Exists(v)) return v;
            }
        }
        foreach (var p in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                                  Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) }) {
            string c = Path.Combine(p, folder, exeName);
            if (File.Exists(c)) return c;
        }
        return null;
    }

    // Chrome keeps <user-data-dir>\lockfile open while it runs with that profile.
    static bool InUse(string dir) {
        string lockfile = Path.Combine(dir, "lockfile");
        if (!File.Exists(lockfile)) return false;
        try { File.Delete(lockfile); return false; } catch { return true; }
    }

    static int Isolated(string target, string portal, string session, string browser, bool waitForUso) {
        if (portal == "-") portal = "";
        string exe = BrowserPath(browser);
        string dir = null;
        // Separate pools per browser: a Chrome profile folder cannot be opened by Edge and the other way round.
        string pool = Path.Combine(Base, browser == "edge" ? "profiles-edge" : "profiles");
        for (int n = 1; n <= 9 && dir == null; n++) {
            string d = Path.Combine(pool, "parallel-" + n);
            if (!InUse(d)) dir = d;
        }
        if (exe == null || dir == null) { Log("isolated.log", (exe == null ? browser + " not found" : "no free profile") + " for " + target); return 1; }
        Directory.CreateDirectory(dir);
        Log("isolated.log", "profile " + dir + " | cleared " + ClearSignInData(dir) + " sign-in stores | target " + target);

        // Only to wait for the USO Chrome extension: a setup page served here, which then goes to the application.
        TcpListener listener = null;
        string setupUrl = target;
        if (waitForUso) {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            setupUrl = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/setup";
        }
        // SSL_TEST_DEBUG_PORT: tests only, to inspect the window; never set in normal use.
        string testPort = Environment.GetEnvironmentVariable("SSL_TEST_DEBUG_PORT");
        string debug = string.IsNullOrEmpty(testPort) ? "" : "--remote-debugging-port=" + testPort + " ";
        // Edge signs a new profile in to the Microsoft account of Windows and turns on sync, which brings the user's
        // extensions, favorites and passwords (and their welcome pages) into the separate window. Keep it a clean profile.
        string edgeOnly = browser == "edge" ? "--disable-features=msImplicitSignin --disable-sync " : "";
        var chrome = Process.Start(new ProcessStartInfo(exe, debug + edgeOnly + "--user-data-dir=" + Quote(dir) + " --no-first-run --no-default-browser-check --new-window " + Quote(setupUrl)) { UseShellExecute = false });
        Log("isolated.log", "opened " + setupUrl + " in " + browser + " pid " + chrome.Id + " for portal " + (portal == "" ? "(none)" : portal));
        var list = ReadSessions().Where(s => Alive(s.pid) && s.dir != dir).ToList();
        list.Add(new Session { pid = chrome.Id, dir = dir, portal = portal == "" ? null : portal, session = session, started = DateTime.UtcNow.ToString("o") });
        WriteSessions(list);
        if (listener == null) return 0;

        // Each connection on its own thread, with a read time limit: Chrome opens spare connections in advance and
        // may leave them idle, which must not block the page's own requests.
        var finished = new ManualResetEvent(false);
        var acceptor = new Thread(() => {
            while (!finished.WaitOne(0)) {
                TcpClient client;
                try { client = listener.AcceptTcpClient(); } catch { return; }
                ThreadPool.QueueUserWorkItem(_ => Serve(client, target, finished));
            }
        }) { IsBackground = true };
        acceptor.Start();
        bool completed = finished.WaitOne(TimeSpan.FromMinutes(10));
        Log("isolated.log", completed ? "USO extension active; redirected to " + target : "setup page not completed within 10 minutes");
        Thread.Sleep(300);
        listener.Stop();
        return 0;
    }

    static void Serve(TcpClient client, string target, ManualResetEvent finished) {
        using (client) {
            try {
                client.ReceiveTimeout = 3000;
                var stream = client.GetStream();
                var reader = new StreamReader(stream, Encoding.ASCII);
                string requestLine = reader.ReadLine() ?? "";
                if (requestLine == "") return;
                while (!string.IsNullOrEmpty(reader.ReadLine())) { }
                bool done = requestLine.StartsWith("GET /done");
                byte[] body = Encoding.UTF8.GetBytes(done ? "ok" : SetupPage(target));
                const string crlf = "\r\n";
                byte[] headers = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK" + crlf + "Content-Type: " + (done ? "text/plain" : "text/html; charset=utf-8") + crlf +
                    "Content-Length: " + body.Length + crlf + "Cache-Control: no-store" + crlf + "Connection: close" + crlf + crlf);
                stream.Write(headers, 0, headers.Length); stream.Write(body, 0, body.Length); stream.Flush();
                if (done) finished.Set();
            } catch { /* idle or closed connection */ }
        }
    }

    static string SetupPage(string target) {
        string t = Json.Serialize(target);
        return @"<!doctype html><html lang=""en""><head><meta charset=""utf-8""><title>Preparing a separate session</title>
<style>body{font:15px/1.5 ""Segoe UI"",sans-serif;background:#edf2f5;color:#17242c;display:grid;place-items:center;min-height:100vh;margin:0}
.panel{width:min(620px,92vw);background:#fff;border:1px solid #c8d4dc;border-top:5px solid #126b72;border-radius:8px;padding:28px}
h1{font-size:20px;margin:0 0 10px}.ok{color:#1d5b2f}.todo{color:#7a4100}ol{padding-left:20px}
a.btn{display:inline-block;margin-top:6px;padding:8px 14px;border:1px solid #126b72;border-radius:4px;color:#126b72;text-decoration:none}
.muted{color:#4a5b66;font-size:13px}</style></head><body><div class=""panel"">
<h1>Preparing a separate session</h1><p id=""status"">Checking this browser window...</p>
<div id=""steps"" hidden><p class=""todo""><strong>The USO Chrome extension is not active in this separate browser.</strong>
It is normally installed for you by your organisation. If Chrome shows <strong>New extension added</strong> (or a warning in the
<strong>&#8942;</strong> menu), choose <strong>Enable extension</strong>; otherwise add it from the Chrome Web Store:<br>
<a class=""btn"" target=""_blank"" href=""https://chromewebstore.google.com/detail/" + UsoId + @""">USO Chrome extension</a></p>
<p class=""muted"">This page continues by itself once the extension is active.</p></div></div>
<script>
var target = " + t + @";
function usoPresent() { return /(?:^|;\s*)(usoNativeHost|ChromeExtM3|usoClientExt)=/.test(document.cookie); }
setTimeout(function () {
  if (usoPresent()) {
    document.getElementById('status').innerHTML = '<span class=""ok"">USO Chrome extension active.</span> Opening the application...';
    fetch('/done').catch(function () {}).then(function () { location.replace(target); });
    return;
  }
  document.getElementById('status').textContent = 'Waiting for the USO Chrome extension...';
  document.getElementById('steps').hidden = false;
  setTimeout(function () { location.reload(); }, 3000);
}, 1200);
</script></body></html>";
    }
}

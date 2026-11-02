using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("项目工作台")]
[assembly: AssemblyProduct("项目工作台")]
[assembly: AssemblyDescription("本机项目工作台启动器")]
[assembly: AssemblyVersion("1.3.2.0")]
[assembly: AssemblyFileVersion("1.3.2.0")]

internal static class Launcher {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static string Root = AppDomain.CurrentDomain.BaseDirectory;
    internal static string[] Arguments;
    internal static string ConfiguredDataDirectory() {
        try {
            string config = Path.Combine(Root, "workbench.json");
            if (!File.Exists(config)) return null;
            Dictionary<string,object> value = Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config, Encoding.UTF8));
            object directory;
            return value.TryGetValue("dataDirectory", out directory) && directory is string ? Path.GetFullPath(Path.Combine(Root, (string)directory)) : null;
        } catch { return null; }
    }
    internal static string Option(string name) {
        int i = Array.IndexOf(Arguments, name);
        return i >= 0 && i + 1 < Arguments.Length ? Arguments[i + 1] : null;
    }
    internal static string Quote(string s) {
        if (s.IndexOf('"') >= 0) throw new InvalidOperationException("文件夹路径中不能含双引号。");
        return "\"" + s + "\"";
    }
    internal static string DataDirectory {
        get { return Option("--data-dir") ?? ConfiguredDataDirectory() ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ProjectWorkbench"); }
    }
    internal static Dictionary<string,object> StartBackend() {
        string node = Path.Combine(Root, "runtime", "node.exe");
        if (!File.Exists(node)) {
            node = null;
            foreach (string folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
                string candidate;
                try { candidate = Path.Combine(folder.Trim().Trim('"'), "node.exe"); } catch { continue; }
                if (File.Exists(candidate)) { node = candidate; break; }
            }
        }
        string script = Path.Combine(Root, "app", "start.cjs");
        if (String.IsNullOrEmpty(node)) throw new FileNotFoundException("请先安装 Node.js 24.2 或更高版本，并重新打开启动器。");
        if (!File.Exists(script)) throw new FileNotFoundException("程序文件不完整，请保留整个工作台文件夹后重试。");
        string args = Quote(script) + " --no-open";
        foreach (string key in new string[] { "--folder", "--data-dir", "--storage-root" }) {
            string value = Option(key);
            if (!String.IsNullOrEmpty(value)) args += " " + key + " " + Quote(value);
        }
        ProcessStartInfo info = new ProcessStartInfo(node, args);
        info.WorkingDirectory = Root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        using (Process child = Process.Start(info)) {
            Task<string> output = child.StandardOutput.ReadLineAsync();
            if (!output.Wait(60000)) {
                try { child.Kill(); } catch {}
                throw new TimeoutException("启动等待超时。请稍后重试，或查看启动错误记录。");
            }
            string line = output.Result;
            if (String.IsNullOrWhiteSpace(line)) {
                if (!child.WaitForExit(5000)) { try { child.Kill(); } catch {} }
                string detail = child.StandardError.ReadToEnd().Trim();
                throw new InvalidOperationException(String.IsNullOrEmpty(detail) ? "后台未返回启动结果，请查看错误记录。" : detail);
            }
            Dictionary<string,object> result = Json.Deserialize<Dictionary<string,object>>(line);
            Uri address;
            if (!result.ContainsKey("url") || !Uri.TryCreate(Convert.ToString(result["url"]), UriKind.Absolute, out address) || address.Scheme != "http" || address.Host != "127.0.0.1")
                throw new InvalidOperationException("启动程序返回了无效的本机地址。");
            return result;
        }
    }
    internal static void WriteFailure(Exception ex) {
        try { Directory.CreateDirectory(DataDirectory); File.AppendAllText(Path.Combine(DataDirectory, "启动错误.log"), DateTime.Now.ToString("s") + " [desktop launcher] " + ex.ToString() + Environment.NewLine, Encoding.UTF8); } catch {}
    }
    [STAThread]
    private static int Main(string[] args) {
        Arguments = args;
        if (Array.IndexOf(args, "--verify") >= 0) {
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            try { Console.WriteLine(Json.Serialize(StartBackend())); return 0; }
            catch (Exception ex) { WriteFailure(ex); Console.Error.WriteLine(ex.Message); return 1; }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new StartupWindow());
        return 0;
    }
    private sealed class StartupWindow : Form {
        private Label message;
        private Label detail;
        private Timer timer;
        private int elapsed;
        internal StartupWindow() {
            Text = "项目工作台";
            ClientSize = new Size(430, 150);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(247, 249, 253);
            try { Icon = new Icon(Path.Combine(Root, "app", "workbench.ico")); } catch {}
            message = new Label { Text = "正在打开项目工作台…", Font = new Font("Microsoft YaHei UI", 13, FontStyle.Bold), ForeColor = Color.FromArgb(28, 45, 73), AutoSize = false, Location = new Point(25, 25), Size = new Size(380, 32) };
            detail = new Label { Text = "首次启动可能需要稍等片刻。", Font = new Font("Microsoft YaHei UI", 9), ForeColor = Color.FromArgb(94, 108, 130), AutoSize = false, Location = new Point(26, 69), Size = new Size(380, 24) };
            ProgressBar bar = new ProgressBar { Style = ProgressBarStyle.Marquee, Location = new Point(27, 112), Size = new Size(375, 7) };
            Controls.Add(message); Controls.Add(detail); Controls.Add(bar);
            timer = new Timer { Interval = 1000 };
            timer.Tick += delegate { elapsed++; detail.Text = "正在准备工作台，请稍候（" + elapsed + " 秒）"; };
            Shown += delegate { timer.Start(); Task.Factory.StartNew(Start); };
            FormClosed += delegate { timer.Stop(); timer.Dispose(); };
        }
        private void Start() {
            try {
                Dictionary<string,object> result = StartBackend();
                string url = Convert.ToString(result["url"]);
                if (IsDisposed) return;
                BeginInvoke((Action)delegate {
                    try {
                        message.Text = "正在打开工作台页面…";
                        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                        Close();
                    } catch (Exception ex) { ShowFailure(ex); }
                });
            } catch (Exception ex) { if (!IsDisposed) BeginInvoke((Action)delegate { ShowFailure(ex); }); }
        }
        private void ShowFailure(Exception ex) {
            WriteFailure(ex);
            timer.Stop();
            string reason = ex.Message.Length > 900 ? ex.Message.Substring(0, 900) : ex.Message;
            MessageBox.Show(this, "没有成功打开项目工作台。\n\n" + reason + "\n\n详细记录：" + Path.Combine(DataDirectory, "启动错误.log"), "项目工作台 · 启动未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
        }
    }
}

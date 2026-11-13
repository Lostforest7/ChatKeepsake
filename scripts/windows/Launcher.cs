using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;

[assembly: System.Reflection.AssemblyTitle("ChatKeepsake")]
[assembly: System.Reflection.AssemblyProduct("ChatKeepsake")]

internal static class Launcher
{
    private static int Main()
    {
        try
        {
            if (!Console.IsOutputRedirected)
                Console.Title = "ChatKeepsake";
            Console.OutputEncoding = new UTF8Encoding(false);
            if (RunApplication() == 0)
                return 0;
            return ShowError("ChatKeepsake 没能打开，请查看上面的提示。");
        }
        catch (Exception error)
        {
            return ShowError(error.Message);
        }
    }

    private static int RunApplication()
    {
        string app = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
        if (!Directory.Exists(app))
            throw new IOException("程序文件不完整。请将下载的 ZIP 全部解压缩后再打开。");

        var files = new List<FileStream>();
        try
        {
            VerifyApplication(app, files);
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(app, "node.exe"),
                Arguments = "server.js",
                WorkingDirectory = app,
                UseShellExecute = false,
                RedirectStandardInput = true
            };
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            using (Process server = Process.Start(start))
            {
                server.StandardInput.Close();
                server.WaitForExit();
                return server.ExitCode;
            }
        }
        finally
        {
            foreach (FileStream file in files)
                file.Dispose();
        }
    }

    // The file list and hashes are embedded before signing, so the signature
    // also identifies the application files that this launcher will execute.
    private static void VerifyApplication(string app, List<FileStream> files)
    {
        var expected = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using (Stream manifest = typeof(Launcher).Assembly.GetManifestResourceStream("ChatKeepsake.files"))
        using (var reader = new StreamReader(manifest, Encoding.UTF8))
        {
            string entry;
            while ((entry = reader.ReadLine()) != null)
            {
                string[] parts = entry.Split(new[] { ' ' }, 2);
                expected.Add(parts[1], parts[0]);
            }
        }

        using (SHA256 sha256 = SHA256.Create())
        {
            foreach (string file in ApplicationFiles(app))
            {
                string relative = file.Substring(app.Length + 1).Replace('\\', '/');
                string expectedHash;
                if (!expected.TryGetValue(relative, out expectedHash))
                    throw new IOException("程序目录包含额外文件。请将下载的 ZIP 解压到一个新文件夹。");

                // Keep the checked files open for reading while the application uses them.
                FileStream stream = File.OpenRead(file);
                files.Add(stream);
                string hash = BitConverter.ToString(sha256.ComputeHash(stream)).Replace("-", "");
                if (!String.Equals(hash, expectedHash, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("程序文件有改动。请从项目发布页重新下载并解压。");
                expected.Remove(relative);
            }
        }
        if (expected.Count != 0)
            throw new IOException("程序文件不完整。请将下载的 ZIP 全部解压缩后再打开。");
    }

    private static IEnumerable<string> ApplicationFiles(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("程序目录包含链接。请将下载的 ZIP 解压到一个新文件夹。");

        foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
        {
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("程序目录包含链接。请将下载的 ZIP 解压到一个新文件夹。");
            if ((attributes & FileAttributes.Directory) == 0)
            {
                yield return entry;
                continue;
            }
            foreach (string file in ApplicationFiles(entry))
                yield return file;
        }
    }

    private static int ShowError(string message)
    {
        Console.Error.WriteLine(message);
        if (!Console.IsInputRedirected)
        {
            Console.Error.WriteLine("按任意键关闭。");
            Console.ReadKey(true);
        }
        return 1;
    }
}

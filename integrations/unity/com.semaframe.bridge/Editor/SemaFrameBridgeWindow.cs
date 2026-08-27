using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace SemaFrame.Bridge.Editor
{
    internal sealed class SemaFrameBridgeWindow : EditorWindow
    {
        private const long MaximumArchiveBytes = 512L * 1024L * 1024L;
        private const int MaximumJsonBytes = 1024 * 1024;
        private static readonly HashSet<string> AllowedEntries = new HashSet<string>(StringComparer.Ordinal)
        {
            "semaframe.exchange.json", "fidelity-report.json", "scene.usda", "geometry.glb", "exact/model.step"
        };

        private string endpoint = "http://127.0.0.1:8788";
        private string sessionId = "";
        [NonSerialized] private string setupJson = "";
        [NonSerialized] private string bearer = "";
        private bool preferOptionalUsdImporter = true;
        private bool busy;
        private string status = "Not connected";

        private static BridgeRuntime Runtime { get; } = new BridgeRuntime();

        [MenuItem("Window/SemaFrame/Bridge")]
        private static void OpenWindow()
        {
            GetWindow<SemaFrameBridgeWindow>("SemaFrame Bridge");
        }

        private void OnGUI()
        {
            EditorGUILayout.LabelField("SemaFrame Scene Exchange", EditorStyles.boldLabel);
            if (GUILayout.Button("Paste setup JSON from clipboard"))
            {
                setupJson = GUIUtility.systemCopyBuffer ?? "";
                status = setupJson.Length == 0 ? "Clipboard is empty" : "Setup JSON loaded; choose Connect";
            }
            setupJson = EditorGUILayout.PasswordField("Setup JSON (masked)", setupJson);
            endpoint = EditorGUILayout.TextField("Loopback endpoint", endpoint);
            sessionId = EditorGUILayout.TextField("Session UUID", sessionId);
            bearer = EditorGUILayout.PasswordField("Session capability", bearer);
            preferOptionalUsdImporter = EditorGUILayout.Toggle("Prefer USD Importer", preferOptionalUsdImporter);
            EditorGUILayout.HelpBox(
                "The capability stays in process memory. Pulls are immutable; pushes are reviewable proposals.",
                MessageType.Info
            );
            using (new EditorGUI.DisabledScope(busy))
            {
                if (GUILayout.Button("Connect")) _ = RunAsync(ConnectAsync);
                if (GUILayout.Button("Pull Latest Exchange")) _ = RunAsync(PullAsync);
                if (GUILayout.Button("Propose Changed Imported Transforms")) _ = RunAsync(ProposeAsync);
                if (GUILayout.Button("Disconnect"))
                {
                    Runtime.Clear();
                    setupJson = "";
                    bearer = "";
                    status = "Disconnected";
                }
            }
            EditorGUILayout.LabelField("Status", status, EditorStyles.wordWrappedLabel);
        }

        private async Task RunAsync(Func<Task> operation)
        {
            if (busy) return;
            busy = true;
            Repaint();
            try
            {
                await operation();
            }
            catch (Exception cause)
            {
                status = cause.Message;
                Debug.LogError($"SemaFrame Bridge: {cause.Message}");
            }
            finally
            {
                busy = false;
                Repaint();
            }
        }

        private async Task ConnectAsync()
        {
            Runtime.Clear();
            try
            {
                if (string.IsNullOrWhiteSpace(setupJson)) Runtime.Configure(endpoint, sessionId, bearer);
                else Runtime.ConfigureFromSetupJson(setupJson);
                JObject view = await Runtime.GetViewAsync();
                if (!string.Equals((string)view["target"], "unity", StringComparison.Ordinal))
                    throw new InvalidDataException("This Bridge session targets another host");
                status = "Connected; capability retained in memory only";
            }
            catch
            {
                Runtime.Clear();
                throw;
            }
            finally
            {
                setupJson = "";
                bearer = "";
            }
        }

        private async Task PullAsync()
        {
            JObject view = await Runtime.GetViewAsync();
            JObject publication = RequireObject(view, "publication");
            string digest = RequireString(publication, "exchangeDigest");
            byte[] archive = await Runtime.GetBytesAsync(
                "/exchange?digest=" + Uri.EscapeDataString(digest), MaximumArchiveBytes,
                "application/vnd.semaframe.exchange+zip"
            );
            if (!string.Equals(Sha256(archive), digest, StringComparison.Ordinal))
                throw new InvalidDataException("Exchange archive digest mismatch");
            string staging = Path.Combine("Library", "SemaFrameBridge", digest.Substring(7, 16));
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            Directory.CreateDirectory(staging);
            JObject manifest = ExtractAndValidate(archive, staging);
            GameObject imported = null;
            if (preferOptionalUsdImporter)
                imported = TryImportOptionalUsd(Path.Combine(staging, "scene.usda"), manifest);
            if (imported == null)
            {
                string assetDirectory = "Assets/SemaFrameBridge/Generated/" + digest.Substring(7, 12) + "-" + Guid.NewGuid().ToString("N");
                imported = SemaFrameGlbImporter.Import(Path.Combine(staging, "geometry.glb"), manifest, assetDirectory);
            }
            JObject source = RequireObject(manifest, "source");
            SemaFrameBridgeSource marker = imported.AddComponent<SemaFrameBridgeSource>();
            marker.Assign(RequireString(source, "workspaceId"), RequireInt(source, "revision"), digest);
            imported.name = $"SemaFrame {source["workspaceId"]} r{source["revision"]}";
            foreach (SemaFrameBridgeSource previous in FindObjectsByType<SemaFrameBridgeSource>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (previous != marker) DestroyImmediate(previous.gameObject);
            }
            Selection.activeGameObject = imported;
            status = $"Pulled revision {source["revision"]}; {imported.GetComponentsInChildren<SemaFrameStableId>(true).Length} stable nodes";
        }

        private async Task ProposeAsync()
        {
            SemaFrameBridgeSource source = FindFirstObjectByType<SemaFrameBridgeSource>(FindObjectsInactive.Include);
            if (source == null) throw new InvalidOperationException("Pull an exchange before proposing transforms");
            JArray changes = new JArray();
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (SemaFrameStableId item in source.GetComponentsInChildren<SemaFrameStableId>(true).OrderBy(x => x.StableId, StringComparer.Ordinal))
            {
                if (!item.HasTransformChanged()) continue;
                if (!seen.Add(item.StableId)) throw new InvalidOperationException("Imported scene maps a stable ID more than once: " + item.StableId);
                Transform transform = item.transform;
                Vector3 position = transform.localPosition;
                Quaternion unity = transform.localRotation;
                Quaternion sema = new Quaternion(-unity.x, -unity.y, unity.z, unity.w).normalized;
                Vector3 rotation = QuaternionToEulerXyz(sema);
                Vector3 scale = transform.localScale;
                if (!Finite(position) || !Finite(rotation) || !Finite(scale) || scale.x <= 0f || scale.y <= 0f || scale.z <= 0f)
                    throw new InvalidOperationException(item.StableId + " has a non-finite value or non-positive scale");
                changes.Add(new JObject
                {
                    ["changeId"] = $"unity-transform-{changes.Count + 1}",
                    ["kind"] = "transform",
                    ["componentId"] = item.StableId,
                    ["placement"] = new JObject
                    {
                        ["space"] = "world3d",
                        ["position"] = Vector(position.x, position.y, -position.z),
                        ["rotation"] = Vector(rotation.x, rotation.y, rotation.z),
                        ["scale"] = Vector(scale.x, scale.y, scale.z)
                    }
                });
                if (changes.Count > 100) throw new InvalidOperationException("A proposal can contain at most 100 changed nodes");
            }
            if (changes.Count == 0) throw new InvalidOperationException("Imported scene has no changed stable nodes");
            JObject proposal = new JObject
            {
                ["format"] = "semaframe-bridge-change-proposal",
                ["version"] = "1.0",
                ["proposalId"] = "unity-" + Guid.NewGuid().ToString("D"),
                ["target"] = "unity",
                ["source"] = new JObject
                {
                    ["workspaceId"] = source.WorkspaceId,
                    ["baseRevision"] = source.BaseRevision,
                    ["exchangeDigest"] = source.ExchangeDigest
                },
                ["changes"] = changes,
                ["note"] = "Explicit transform proposal from Unity 6; requires SemaFrame review."
            };
            JObject receipt = await Runtime.PostJsonAsync("/proposals", proposal);
            if (!string.Equals((string)receipt["status"], "review_required", StringComparison.Ordinal))
                throw new InvalidDataException("Bridge did not queue the proposal for review");
            status = $"Queued {changes.Count} transforms for SemaFrame review";
        }

        private static JObject ExtractAndValidate(byte[] archive, string destination)
        {
            JObject manifest;
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long expanded = 0;
            using (MemoryStream memory = new MemoryStream(archive, false))
            using (ZipArchive package = new ZipArchive(memory, ZipArchiveMode.Read, false))
            {
                foreach (ZipArchiveEntry entry in package.Entries)
                {
                    string name = entry.FullName;
                    int unixMode = (entry.ExternalAttributes >> 16) & 0xF000;
                    if (!AllowedEntries.Contains(name) || name.StartsWith("/", StringComparison.Ordinal) ||
                        name.Contains("\\") || name.Split('/').Any(part => part.Length == 0 || part == "." || part == "..") ||
                        unixMode == 0xA000 || !names.Add(name))
                        throw new InvalidDataException("Unsafe or unknown exchange entry: " + name);
                    expanded += entry.Length;
                    if (expanded > MaximumArchiveBytes) throw new InvalidDataException("Expanded exchange exceeds the adapter limit");
                    string output = Path.GetFullPath(Path.Combine(destination, name.Replace('/', Path.DirectorySeparatorChar)));
                    string root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
                    if (!output.StartsWith(root, StringComparison.Ordinal)) throw new InvalidDataException("Exchange path traversal rejected");
                    Directory.CreateDirectory(Path.GetDirectoryName(output) ?? destination);
                    entry.ExtractToFile(output, true);
                }
            }
            foreach (string required in new[] { "semaframe.exchange.json", "fidelity-report.json", "scene.usda", "geometry.glb" })
                if (!names.Contains(required)) throw new InvalidDataException("Exchange is missing " + required);
            string manifestPath = Path.Combine(destination, "semaframe.exchange.json");
            if (new FileInfo(manifestPath).Length > MaximumJsonBytes)
                throw new InvalidDataException("Exchange manifest exceeds the adapter limit");
            manifest = JObject.Parse(File.ReadAllText(manifestPath, Encoding.UTF8));
            if ((string)manifest["format"] != "semaframe-scene-exchange" || (string)manifest["version"] != "1.0")
                throw new InvalidDataException("Unsupported SemaFrame exchange");
            JArray manifestNodes = RequireArray(manifest, "nodes");
            HashSet<string> stableIds = new HashSet<string>(
                manifestNodes.OfType<JObject>().Select(node => RequireString(node, "stableId")), StringComparer.Ordinal
            );
            if (manifestNodes.Count > 10000 || stableIds.Count != manifestNodes.Count || stableIds.Any(string.IsNullOrEmpty))
                throw new InvalidDataException("Exchange stable IDs are invalid, duplicated, or too numerous");
            foreach (JObject entry in RequireArray(manifest, "files").OfType<JObject>())
            {
                string name = RequireString(entry, "path");
                if (!AllowedEntries.Contains(name) || !names.Contains(name))
                    throw new InvalidDataException("Manifest references an unavailable entry");
                byte[] bytes = File.ReadAllBytes(Path.Combine(destination, name.Replace('/', Path.DirectorySeparatorChar)));
                if ((long)entry["byteLength"] != bytes.LongLength || RequireString(entry, "sha256") != Sha256(bytes))
                    throw new InvalidDataException("Exchange integrity check failed: " + name);
            }
            JArray fileEntries = RequireArray(manifest, "files");
            HashSet<string> declared = new HashSet<string>(
                fileEntries.OfType<JObject>().Select(entry => RequireString(entry, "path")),
                StringComparer.OrdinalIgnoreCase
            );
            if (declared.Count != fileEntries.Count ||
                !names.Where(name => name != "semaframe.exchange.json").All(declared.Contains) || declared.Count != names.Count - 1)
                throw new InvalidDataException("Exchange files and manifest declarations disagree");
            return manifest;
        }

        private static GameObject TryImportOptionalUsd(string usdaPath, JObject manifest)
        {
            string assetDirectory = "Assets/SemaFrameBridge/Imported";
            Directory.CreateDirectory(assetDirectory);
            string destination = assetDirectory + "/scene-" + Sha256(File.ReadAllBytes(usdaPath)).Substring(7, 12) + ".usda";
            bool created = !File.Exists(destination);
            if (created) File.Copy(usdaPath, destination, false);
            AssetDatabase.ImportAsset(destination, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
            GameObject asset = AssetDatabase.LoadAssetAtPath<GameObject>(destination);
            if (asset == null) return null; // The optional com.unity.importer.usd 1.0.0-pre.2 is not active.
            GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(asset);
            int expected = 0;
            int mapped = 0;
            foreach (JObject node in RequireArray(manifest, "nodes").OfType<JObject>())
            {
                string primPath = (string)node["usdPrimPath"];
                if (string.IsNullOrEmpty(primPath)) continue;
                expected++;
                string leaf = primPath.Split('/').Last(part => part.Length > 0);
                Transform[] candidates = instance.GetComponentsInChildren<Transform>(true)
                    .Where(item => string.Equals(item.name, leaf, StringComparison.Ordinal)).ToArray();
                if (candidates.Length != 1) continue;
                SemaFrameStableId stable = candidates[0].gameObject.AddComponent<SemaFrameStableId>();
                stable.Assign(RequireString(node, "stableId"));
                stable.CaptureBaseline();
                mapped++;
            }
            if (expected > 0 && mapped == expected) return instance;
            DestroyImmediate(instance);
            if (created) AssetDatabase.DeleteAsset(destination);
            return null;
        }

        private static JObject Vector(float x, float y, float z) => new JObject { ["x"] = x, ["y"] = y, ["z"] = z };

        private static bool Finite(Vector3 value) =>
            !float.IsNaN(value.x) && !float.IsInfinity(value.x) &&
            !float.IsNaN(value.y) && !float.IsInfinity(value.y) &&
            !float.IsNaN(value.z) && !float.IsInfinity(value.z);

        private static Vector3 QuaternionToEulerXyz(Quaternion q)
        {
            double sinr = 2.0 * (q.w * q.x + q.y * q.z);
            double cosr = 1.0 - 2.0 * (q.x * q.x + q.y * q.y);
            double x = Math.Atan2(sinr, cosr);
            double sinp = 2.0 * (q.w * q.y - q.z * q.x);
            double y = Math.Abs(sinp) >= 1.0 ? (sinp < 0.0 ? -1.0 : 1.0) * Math.PI / 2.0 : Math.Asin(sinp);
            double siny = 2.0 * (q.w * q.z + q.x * q.y);
            double cosy = 1.0 - 2.0 * (q.y * q.y + q.z * q.z);
            double z = Math.Atan2(siny, cosy);
            return new Vector3((float)x, (float)y, (float)z);
        }

        internal static JObject RequireObject(JObject value, string name) => value[name] as JObject ?? throw new InvalidDataException(name + " must be an object");
        internal static JArray RequireArray(JObject value, string name) => value[name] as JArray ?? throw new InvalidDataException(name + " must be an array");
        internal static string RequireString(JObject value, string name) => (string)value[name] ?? throw new InvalidDataException(name + " must be text");
        internal static int RequireInt(JObject value, string name) => value[name]?.Value<int>() ?? throw new InvalidDataException(name + " must be an integer");
        internal static string Sha256(byte[] value)
        {
            using (SHA256 algorithm = SHA256.Create())
                return "sha256:" + BitConverter.ToString(algorithm.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
        }
    }

    internal sealed class BridgeRuntime
    {
        private const int MaximumSetupBytes = 64 * 1024;
        private string endpoint = "";
        private string session = "";
        private string bearer = "";

        public void Configure(string endpointValue, string sessionValue, string bearerValue)
        {
            Uri uri = new Uri(endpointValue, UriKind.Absolute);
            string literalHost = uri.Host.Trim('[', ']');
            if ((uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
                !new[] { "localhost", "127.0.0.1", "::1" }.Contains(literalHost, StringComparer.OrdinalIgnoreCase) ||
                uri.IsDefaultPort || uri.UserInfo.Length > 0 || uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0)
                throw new ArgumentException("Bridge endpoint must be an explicit-port loopback http(s) origin");
            if (!Guid.TryParseExact(sessionValue, "D", out Guid parsedSession)) throw new ArgumentException("Session must be a UUID");
            if (bearerValue == null || bearerValue.Length != 43 || bearerValue.Any(character => !(char.IsLetterOrDigit(character) || character == '_' || character == '-')))
                throw new ArgumentException("Capability must contain 43 base64url characters");
            endpoint = uri.GetLeftPart(UriPartial.Authority);
            session = parsedSession.ToString("D");
            bearer = bearerValue;
        }

        public void ConfigureFromSetupJson(string setupValue)
        {
            if (setupValue == null || Encoding.UTF8.GetByteCount(setupValue) > MaximumSetupBytes)
                throw new InvalidDataException("Bridge setup JSON is missing or exceeds 64 KiB");
            JObject setup;
            try
            {
                setup = JObject.Parse(setupValue);
            }
            catch (JsonException cause)
            {
                throw new InvalidDataException("Bridge setup JSON is invalid", cause);
            }
            if ((string)setup["format"] != "semaframe-bridge-setup" || (string)setup["version"] != "1.0" ||
                (string)setup["target"] != "unity")
                throw new InvalidDataException("Bridge setup JSON is unsupported or targets another host");
            string sessionValue = (string)setup["sessionId"] ?? "";
            if (!Guid.TryParseExact(sessionValue, "D", out Guid parsedSession))
                throw new InvalidDataException("Bridge setup sessionId must be a UUID");
            string canonicalSession = parsedSession.ToString("D");
            Uri pull = RequireSetupUri((string)setup["pullUrl"], "pullUrl");
            Uri exchange = RequireSetupUri((string)setup["exchangeUrl"], "exchangeUrl");
            string expectedPath = "/v1/bridge/sessions/" + canonicalSession;
            if (pull.AbsolutePath != expectedPath || exchange.AbsolutePath != expectedPath + "/exchange" ||
                pull.GetLeftPart(UriPartial.Authority) != exchange.GetLeftPart(UriPartial.Authority))
                throw new InvalidDataException("Bridge setup URLs do not match its session");
            JObject authorization = setup["authorization"] as JObject ??
                throw new InvalidDataException("Bridge setup authorization must be an object");
            if ((string)authorization["header"] != "Authorization")
                throw new InvalidDataException("Bridge setup authorization header is unsupported");
            string authorizationValue = (string)authorization["value"] ?? "";
            if (!authorizationValue.StartsWith("Bearer ", StringComparison.Ordinal))
                throw new InvalidDataException("Bridge setup authorization must use Bearer");
            Configure(pull.GetLeftPart(UriPartial.Authority), canonicalSession, authorizationValue.Substring(7));
        }

        private static Uri RequireSetupUri(string value, string name)
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out Uri uri) || uri.UserInfo.Length > 0 ||
                uri.Query.Length > 0 || uri.Fragment.Length > 0)
                throw new InvalidDataException("Bridge setup " + name + " is not a plain absolute URL");
            return uri;
        }

        public void Clear()
        {
            endpoint = "";
            session = "";
            bearer = "";
        }

        public async Task<JObject> GetViewAsync()
        {
            byte[] bytes = await GetBytesAsync("", MaximumJson(), "application/json");
            JObject envelope = JObject.Parse(Encoding.UTF8.GetString(bytes));
            if (envelope["ok"]?.Value<bool>() != true || !(envelope["data"] is JObject data))
                throw new InvalidDataException("Bridge returned an invalid response envelope");
            return data;
        }

        public async Task<JObject> PostJsonAsync(string path, JObject value)
        {
            using (HttpRequestMessage request = Create(HttpMethod.Post, path))
            {
                request.Content = new StringContent(value.ToString(Formatting.None), Encoding.UTF8, "application/json");
                byte[] bytes = await SendAsync(request, MaximumJson(), "application/json", HttpStatusCode.Accepted);
                JObject envelope = JObject.Parse(Encoding.UTF8.GetString(bytes));
                if (envelope["ok"]?.Value<bool>() != true || !(envelope["data"] is JObject data))
                    throw new InvalidDataException("Bridge returned an invalid proposal receipt");
                return data;
            }
        }

        public async Task<byte[]> GetBytesAsync(string path, long maximum, string mediaType)
        {
            using (HttpRequestMessage request = Create(HttpMethod.Get, path))
                return await SendAsync(request, maximum, mediaType, HttpStatusCode.OK);
        }

        private HttpRequestMessage Create(HttpMethod method, string path)
        {
            if (endpoint.Length == 0 || session.Length == 0 || bearer.Length == 0)
                throw new InvalidOperationException("Connect the SemaFrame Bridge first");
            HttpRequestMessage request = new HttpRequestMessage(method, endpoint + "/v1/bridge/sessions/" + session + path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            return request;
        }

        private static async Task<byte[]> SendAsync(HttpRequestMessage request, long maximum, string mediaType, HttpStatusCode expected)
        {
            using (HttpClientHandler handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
            using (HttpClient client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) })
            using (HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead))
            {
                if (response.StatusCode != expected) throw new HttpRequestException("Bridge returned status " + (int)response.StatusCode);
                if (response.Content.Headers.ContentType == null || !response.Content.Headers.ContentType.MediaType.StartsWith(mediaType, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Bridge returned an unexpected media type");
                if (response.Content.Headers.ContentLength > maximum) throw new InvalidDataException("Bridge response exceeds the adapter limit");
                using (Stream input = await response.Content.ReadAsStreamAsync())
                using (MemoryStream output = new MemoryStream())
                {
                    byte[] buffer = new byte[64 * 1024];
                    while (true)
                    {
                        int count = await input.ReadAsync(buffer, 0, buffer.Length);
                        if (count == 0) break;
                        if (output.Length + count > maximum) throw new InvalidDataException("Bridge response exceeds the adapter limit");
                        output.Write(buffer, 0, count);
                    }
                    return output.ToArray();
                }
            }
        }

        private static int MaximumJson() => 1024 * 1024;
    }

    internal static class SemaFrameGlbImporter
    {
        public static GameObject Import(string path, JObject manifest, string assetDirectory)
        {
            GameObject[] objects = null;
            GameObject root = null;
            Directory.CreateDirectory(assetDirectory);
            AssetDatabase.Refresh();
            try
            {
            byte[] bytes = File.ReadAllBytes(path);
            if (bytes.Length < 20 || BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(0, 4)) != 0x46546c67 ||
                BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4, 4)) != 2 ||
                BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(8, 4)) != bytes.Length)
                throw new InvalidDataException("SemaFrame GLB header is invalid");
            int offset = 12;
            JObject gltf = null;
            byte[] binary = Array.Empty<byte>();
            while (offset + 8 <= bytes.Length)
            {
                int length = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset, 4)));
                uint type = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset + 4, 4));
                offset += 8;
                if (length < 0 || length > bytes.Length - offset) throw new InvalidDataException("GLB chunk is truncated");
                if (type == 0x4E4F534A) gltf = JObject.Parse(Encoding.UTF8.GetString(bytes, offset, length).TrimEnd(' ', '\0'));
                if (type == 0x004E4942) binary = bytes.Skip(offset).Take(length).ToArray();
                offset += length;
            }
            if (offset != bytes.Length) throw new InvalidDataException("GLB contains trailing or truncated data");
            if (gltf == null) throw new InvalidDataException("GLB has no JSON chunk");
            JArray nodes = gltf["nodes"] as JArray ?? throw new InvalidDataException("GLB has no node array");
            objects = new GameObject[nodes.Count];
            if (nodes.Count > 10000) throw new InvalidDataException("GLB exceeds the SemaFrame node limit");
            for (int index = 0; index < nodes.Count; index++)
            {
                JObject node = (JObject)nodes[index];
                GameObject item = new GameObject((string)node["name"] ?? $"Node {index}");
                objects[index] = item;
                JArray translation = node["translation"] as JArray;
                JArray rotation = node["rotation"] as JArray;
                JArray scale = node["scale"] as JArray;
                if (translation != null) item.transform.localPosition = new Vector3(F(translation, 0), F(translation, 1), -F(translation, 2));
                if (rotation != null) item.transform.localRotation = new Quaternion(-F(rotation, 0), -F(rotation, 1), F(rotation, 2), F(rotation, 3));
                if (scale != null) item.transform.localScale = new Vector3(F(scale, 0), F(scale, 1), F(scale, 2));
                string stableId = (string)node["extras"]?["semaframeStableId"];
                if (!string.IsNullOrEmpty(stableId))
                {
                    SemaFrameStableId stable = item.AddComponent<SemaFrameStableId>();
                    stable.Assign(stableId);
                }
                if (node["mesh"] != null) AddMesh(item, gltf, binary, node["mesh"].Value<int>(), assetDirectory);
            }
            HashSet<int> children = new HashSet<int>();
            for (int index = 0; index < nodes.Count; index++)
            {
                foreach (JToken child in nodes[index]["children"] as JArray ?? new JArray())
                {
                    int childIndex = child.Value<int>();
                    objects[childIndex].transform.SetParent(objects[index].transform, false);
                    children.Add(childIndex);
                }
            }
            root = new GameObject("SemaFrame Scene Exchange");
            for (int index = 0; index < objects.Length; index++)
                if (!children.Contains(index)) objects[index].transform.SetParent(root.transform, false);
            foreach (SemaFrameStableId stable in root.GetComponentsInChildren<SemaFrameStableId>(true))
                stable.CaptureBaseline();
            HashSet<string> manifestIds = new HashSet<string>(
                ((JArray)manifest["nodes"]).OfType<JObject>()
                    .Where(item => item["gltfNodeIndex"] != null)
                    .Select(item => (string)item["stableId"])
                    .Where(id => !string.IsNullOrEmpty(id)), StringComparer.Ordinal
            );
            SemaFrameStableId[] importedStable = root.GetComponentsInChildren<SemaFrameStableId>(true);
            HashSet<string> importedIds = new HashSet<string>(importedStable.Select(item => item.StableId), StringComparer.Ordinal);
            if (importedIds.Count != importedStable.Length || !manifestIds.SetEquals(importedIds))
            {
                UnityEngine.Object.DestroyImmediate(root);
                throw new InvalidDataException("GLB stable-ID mapping is incomplete");
            }
            AssetDatabase.SaveAssets();
            return root;
            }
            catch
            {
                if (root != null)
                    UnityEngine.Object.DestroyImmediate(root);
                else if (objects != null)
                    foreach (GameObject item in objects.Where(item => item != null && item.transform.parent == null))
                        UnityEngine.Object.DestroyImmediate(item);
                AssetDatabase.DeleteAsset(assetDirectory);
                throw;
            }
        }

        private static void AddMesh(GameObject target, JObject gltf, byte[] binary, int meshIndex, string assetDirectory)
        {
            string meshAssetPath = assetDirectory + $"/mesh-{meshIndex}.asset";
            Mesh existingMesh = AssetDatabase.LoadAssetAtPath<Mesh>(meshAssetPath);
            JObject meshJson = (JObject)((JArray)gltf["meshes"])[meshIndex];
            JObject primitive = (JObject)((JArray)meshJson["primitives"])[0];
            if (existingMesh != null)
            {
                target.AddComponent<MeshFilter>().sharedMesh = existingMesh;
                MeshRenderer existingRenderer = target.AddComponent<MeshRenderer>();
                existingRenderer.sharedMaterial = Material(gltf, primitive["material"]?.Value<int>() ?? -1, target.name, assetDirectory, meshIndex);
                return;
            }
            if (primitive["mode"] != null && primitive["mode"].Value<int>() != 4)
                throw new InvalidDataException("GLB mesh must use triangle primitives");
            JObject attributes = (JObject)primitive["attributes"];
            Vector3[] positions = ReadVec3(gltf, binary, attributes["POSITION"].Value<int>(), true);
            Vector3[] normals = ReadVec3(gltf, binary, attributes["NORMAL"].Value<int>(), true);
            int[] indices = ReadIndices(gltf, binary, primitive["indices"].Value<int>());
            if (normals.Length != positions.Length || indices.Any(index => index < 0 || index >= positions.Length))
                throw new InvalidDataException("GLB mesh accessors disagree");
            for (int index = 0; index + 2 < indices.Length; index += 3)
            {
                int swap = indices[index + 1];
                indices[index + 1] = indices[index + 2];
                indices[index + 2] = swap;
            }
            Mesh mesh = new Mesh { name = (string)meshJson["name"] ?? target.name + " Mesh", indexFormat = positions.Length > 65535 ? UnityEngine.Rendering.IndexFormat.UInt32 : UnityEngine.Rendering.IndexFormat.UInt16 };
            mesh.vertices = positions;
            mesh.normals = normals;
            mesh.triangles = indices;
            mesh.RecalculateBounds();
            AssetDatabase.CreateAsset(mesh, meshAssetPath);
            target.AddComponent<MeshFilter>().sharedMesh = mesh;
            MeshRenderer renderer = target.AddComponent<MeshRenderer>();
            int materialIndex = primitive["material"]?.Value<int>() ?? -1;
            renderer.sharedMaterial = Material(gltf, materialIndex, target.name, assetDirectory, meshIndex);
        }

        private static Material Material(JObject gltf, int index, string name, string assetDirectory, int meshIndex)
        {
            string materialAssetPath = assetDirectory + (index < 0 ? $"/material-mesh-{meshIndex}.mat" : $"/material-{index}.mat");
            Material existing = AssetDatabase.LoadAssetAtPath<Material>(materialAssetPath);
            if (existing != null) return existing;
            Shader shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            Material material = new Material(shader) { name = name + " Material" };
            if (index >= 0)
            {
                JObject source = (JObject)((JArray)gltf["materials"])[index];
                JArray factor = source["pbrMetallicRoughness"]?["baseColorFactor"] as JArray;
                if (factor != null) material.color = new Color(F(factor, 0), F(factor, 1), F(factor, 2), F(factor, 3));
            }
            AssetDatabase.CreateAsset(material, materialAssetPath);
            return material;
        }

        private static Vector3[] ReadVec3(JObject gltf, byte[] binary, int accessorIndex, bool mirrorZ)
        {
            JObject accessor = (JObject)((JArray)gltf["accessors"])[accessorIndex];
            if ((int)accessor["componentType"] != 5126 || (string)accessor["type"] != "VEC3")
                throw new InvalidDataException("GLB vector accessor is unsupported");
            JObject view = (JObject)((JArray)gltf["bufferViews"])[accessor["bufferView"].Value<int>()];
            int start = (view["byteOffset"]?.Value<int>() ?? 0) + (accessor["byteOffset"]?.Value<int>() ?? 0);
            int stride = view["byteStride"]?.Value<int>() ?? 12;
            int count = accessor["count"].Value<int>();
            long end = count == 0 ? start : (long)start + (long)(count - 1) * stride + 12L;
            if (start < 0 || stride < 12 || count < 0 || end > binary.LongLength)
                throw new InvalidDataException("GLB vector accessor is out of bounds");
            Vector3[] values = new Vector3[count];
            for (int index = 0; index < count; index++)
            {
                int at = checked(start + index * stride);
                float x = BitConverter.ToSingle(binary, at);
                float y = BitConverter.ToSingle(binary, at + 4);
                float z = BitConverter.ToSingle(binary, at + 8);
                values[index] = new Vector3(x, y, mirrorZ ? -z : z);
            }
            return values;
        }

        private static int[] ReadIndices(JObject gltf, byte[] binary, int accessorIndex)
        {
            JObject accessor = (JObject)((JArray)gltf["accessors"])[accessorIndex];
            JObject view = (JObject)((JArray)gltf["bufferViews"])[accessor["bufferView"].Value<int>()];
            int start = (view["byteOffset"]?.Value<int>() ?? 0) + (accessor["byteOffset"]?.Value<int>() ?? 0);
            int type = accessor["componentType"].Value<int>();
            int count = accessor["count"].Value<int>();
            int width = type == 5123 ? 2 : type == 5125 ? 4 : 0;
            long end = (long)start + (long)count * width;
            if (start < 0 || count < 0 || width == 0 || end > binary.LongLength)
                throw new InvalidDataException("GLB index accessor is out of bounds or unsupported");
            int[] values = new int[count];
            for (int index = 0; index < count; index++)
            {
                if (type == 5123) values[index] = BitConverter.ToUInt16(binary, start + index * 2);
                else if (type == 5125) values[index] = checked((int)BitConverter.ToUInt32(binary, start + index * 4));
                else throw new InvalidDataException("GLB index accessor is unsupported");
            }
            return values;
        }

        private static float F(JArray value, int index) => value[index].Value<float>();
    }
}

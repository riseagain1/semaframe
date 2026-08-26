using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Automation;

namespace SemaFrame.VoiceRelay;

internal static partial class Program
{
    private const int ProtocolVersion = 2;
    private const int MaximumFrameBytes = 1_048_576;
    private const int MaximumObservations = 128;
    private const double ObservationRetentionSeconds = 125;
    private const int ControlPairAmbiguityMargin = 24;

    public static int Main()
    {
        // Console control events may be broadcast to both the Node owner and
        // this helper. The owner coordinates authenticated shutdown; if it
        // disappears, inherited stdin closes and the finally block performs
        // the same digest-checked cleanup.
        Console.CancelKeyPress += (_, eventArgs) => eventArgs.Cancel = true;
        using Stream input = Console.OpenStandardInput();
        using Stream output = Console.OpenStandardOutput();
        var runtime = new RelayRuntime();
        try
        {
            while (!runtime.ShouldExit)
            {
                JsonDocument? frame = ReadFrame(input);
                if (frame is null) break;
                using (frame)
                {
                    if (!WriteFrame(output, runtime.Handle(frame.RootElement))) break;
                }
            }
            return 0;
        }
        finally
        {
            runtime.CleanupBeforeExit();
        }
    }

    private static JsonDocument? ReadFrame(Stream input)
    {
        byte[] header = new byte[4];
        if (!ReadExactly(input, header)) return null;
        int length = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(header);
        if (length < 2 || length > MaximumFrameBytes) return null;
        byte[] payload = new byte[length];
        if (!ReadExactly(input, payload)) return null;
        try { return JsonDocument.Parse(payload); }
        catch (JsonException) { return null; }
    }

    private static bool ReadExactly(Stream input, byte[] buffer)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int count = input.Read(buffer, offset, buffer.Length - offset);
            if (count == 0) return false;
            offset += count;
        }
        return true;
    }

    private static bool WriteFrame(Stream output, object value)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value);
        if (payload.Length < 2 || payload.Length > MaximumFrameBytes) return false;
        Span<byte> header = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header, payload.Length);
        try
        {
            output.Write(header);
            output.Write(payload);
            output.Flush();
            return true;
        }
        catch (IOException) { return false; }
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant)]
    private static partial Regex CapabilityPattern();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierPattern();

    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex DigestPattern();

    private static string? StringProperty(JsonElement body, string name, Regex pattern)
    {
        if (!body.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String) return null;
        string? text = value.GetString();
        return text is not null && pattern.IsMatch(text) ? text : null;
    }

    private static string Sha256(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private sealed record Candidate(
        string Id,
        int ProcessId,
        long ProcessStartTicks,
        bool KnownAgentSurface,
        string AppName,
        AutomationElement Window,
        AutomationElement? Composer,
        AutomationElement? Send,
        ControlIdentity? ComposerIdentity,
        ControlIdentity? SendIdentity,
        AutomationElement? InteractionRoot);

    private sealed record Profile(
        string TargetId,
        string Generation,
        int ProcessId,
        long ProcessStartTicks,
        bool KnownAgentSurface,
        string Label,
        AutomationElement Window,
        AutomationElement Composer,
        AutomationElement Send,
        ControlIdentity ComposerIdentity,
        ControlIdentity SendIdentity,
        AutomationElement InteractionRoot,
        AutomationElement? ResponseRoot,
        ControlIdentity? ResponseRootIdentity);

    private sealed record ControlIdentity(string AutomationId, int[] RuntimeId, string ControlTypeName);

    private sealed record BoundControls(
        AutomationElement Composer,
        AutomationElement Send,
        ControlIdentity ComposerIdentity,
        ControlIdentity SendIdentity,
        AutomationElement InteractionRoot,
        int Score);

    private sealed record ResponseBinding(AutomationElement Root, ControlIdentity Identity);

    private enum ResponseMessageKind { Assistant, User, Ambiguous }

    private sealed record ResponseMessage(ResponseMessageKind Kind, string Text);

    private sealed record ResponseSnapshotState(
        IReadOnlyDictionary<string, ResponseMessage> Messages,
        IReadOnlyList<string> Order);

    private sealed record ResponseDelta(bool Ambiguous, string Text);

    private sealed record ActiveStage(string StageId, string Digest, string TargetGeneration);

    private sealed record ActiveProbe(string Digest, string TargetGeneration);

    private enum OwnedDraftCleanupOutcome { None, Cleared, HumanChanged, Unresolved }

    private sealed class Observation
    {
        public required ResponseSnapshotState Baseline { get; init; }
        public required string SentDraft { get; init; }
        public string LastText { get; set; } = "";
        public int Sequence { get; set; }
        public int StableReads { get; set; }
        public long LastChangeTicks { get; set; } = Stopwatch.GetTimestamp();
        public long CreatedTicks { get; init; } = Stopwatch.GetTimestamp();
    }

    private sealed class RelayRuntime
    {
        private string? _capability;
        private readonly Dictionary<string, Candidate> _candidates = [];
        private readonly Dictionary<string, Observation> _observations = [];
        private Profile? _profile;
        private ActiveStage? _activeStage;
        private ActiveProbe? _activeProbe;
        private bool _armed;
        public bool ShouldExit { get; private set; }

        public object Handle(JsonElement request)
        {
            int id = request.ValueKind == JsonValueKind.Object
                && request.TryGetProperty("id", out JsonElement idValue)
                && idValue.TryGetInt32(out int parsedId) ? parsedId : 0;
            try
            {
                if (request.ValueKind != JsonValueKind.Object
                    || !request.TryGetProperty("jsonrpc", out JsonElement version)
                    || version.GetString() != "2.0"
                    || !request.TryGetProperty("method", out JsonElement methodElement)
                    || methodElement.ValueKind != JsonValueKind.String
                    || !request.TryGetProperty("params", out JsonElement parameters)
                    || parameters.ValueKind != JsonValueKind.Object)
                {
                    return Error(id, "invalid_request", "Invalid helper request envelope.");
                }
                string method = methodElement.GetString()!;
                string? capability = StringProperty(request, "capability", CapabilityPattern());
                if (method == "hello")
                {
                    if (_capability is not null || capability is null
                        || !parameters.TryGetProperty("protocolVersion", out JsonElement protocol)
                        || protocol.GetInt32() != ProtocolVersion)
                        return Error(id, "handshake_failed", "Helper handshake failed.");
                    _capability = capability;
                    return Result(id, new { protocolVersion = ProtocolVersion, capability });
                }
                if (capability is null || capability != _capability)
                    return Error(id, "unauthorized", "Helper capability is invalid.");

                return method switch
                {
                    // Windows UI Automation has no consent prompt equivalent;
                    // retain the explicit setup boundary in the cross-platform
                    // protocol and report the current capability.
                    "prepare_accessibility" => Result(id, new { protocolVersion = ProtocolVersion, platform = "windows", accessibility = "authorized" }),
                    "health" => Result(id, new { protocolVersion = ProtocolVersion, platform = "windows", accessibility = "authorized" }),
                    "discover_targets" => Result(id, new { targets = DiscoverTargets() }),
                    "configure_target" => ConfigureTarget(id, parameters),
                    "arm" => Arm(id, parameters),
                    "disarm" => Disarm(id),
                    "test_draft_round_trip" => TestDraftRoundTrip(id, parameters),
                    "stage_draft" => StageDraft(id, parameters),
                    "abort_stage" => AbortStage(id, parameters),
                    "confirm_draft" => ConfirmDraft(id, parameters),
                    "cancel_draft" => CancelDraft(id, parameters),
                    "read_reply" => ReadReply(id, parameters),
                    "shutdown" => Shutdown(id),
                    _ => Error(id, "method_not_found", "Unknown helper method."),
                };
            }
            catch (ElementNotAvailableException)
            {
                return Error(id, "target_lost", "Configured Agent target is unavailable.");
            }
            catch (InvalidOperationException)
            {
                return Error(id, "native_operation_failed", "The native accessibility operation failed.");
            }
            catch (Exception)
            {
                // Never emit native exception details; accessibility trees can
                // contain user-authored text in error descriptions.
                return Error(id, "native_operation_failed", "The native accessibility operation failed.");
            }
        }

        private object[] DiscoverTargets()
        {
            Candidate[] previousCandidates = [.. _candidates.Values];
            var nextCandidates = new Dictionary<string, Candidate>();
            var reusedCandidateIds = new HashSet<string>(StringComparer.Ordinal);
            var result = new List<object>();
            int ownPid = Environment.ProcessId;
            foreach (Process process in Process.GetProcesses())
            {
                using (process)
                {
                    if (result.Count >= 128 || process.Id == ownPid || process.MainWindowHandle == IntPtr.Zero) continue;
                    string processName = process.ProcessName;
                    if (IsForbiddenApplication(processName)) continue;
                    bool knownAgentSurface = IsKnownAgentApplication(processName);
                    AutomationElement window;
                    try { window = AutomationElement.FromHandle(process.MainWindowHandle); }
                    catch (ElementNotAvailableException) { continue; }
                    long processStartTicks;
                    try { processStartTicks = process.StartTime.ToUniversalTime().Ticks; }
                    catch (InvalidOperationException) { continue; }
                    BoundControls? controls = FindControls(window, knownAgentSurface);
                    Candidate? reusable = previousCandidates.FirstOrDefault(candidate =>
                        !reusedCandidateIds.Contains(candidate.Id)
                        && candidate.ProcessId == process.Id
                        && candidate.ProcessStartTicks == processStartTicks
                        && candidate.KnownAgentSurface == knownAgentSurface
                        && SameElementIdentity(candidate.Window, window)
                        && SameElementIdentity(candidate.Composer, controls?.Composer)
                        && SameElementIdentity(candidate.Send, controls?.Send)
                        && SameElementIdentity(candidate.InteractionRoot, controls?.InteractionRoot));
                    string candidateId = reusable?.Id ?? $"candidate-{Guid.NewGuid():D}";
                    reusedCandidateIds.Add(candidateId);
                    string appName = BoundedLabel(processName);
                    string title = BoundedLabel(window.Current.Name);
                    bool compatible = controls is not null;
                    nextCandidates[candidateId] = new Candidate(
                        candidateId,
                        process.Id,
                        processStartTicks,
                        knownAgentSurface,
                        appName,
                        window,
                        controls?.Composer,
                        controls?.Send,
                        controls?.ComposerIdentity,
                        controls?.SendIdentity,
                        controls?.InteractionRoot);
                    var wire = new Dictionary<string, object>
                    {
                        ["candidateId"] = candidateId,
                        ["label"] = controls is null
                            ? BoundedLabel($"{appName} — {title}")
                            : BoundedTargetLabel(appName, title, controls.Composer, controls.Send),
                        ["applicationLabel"] = appName,
                        ["compatible"] = compatible,
                    };
                    if (!compatible)
                        wire["incompatibilityReason"] = "No writable Agent composer and locally bound explicit Send control were verified.";
                    result.Add(wire);
                }
            }
            _candidates.Clear();
            foreach ((string candidateId, Candidate candidate) in nextCandidates)
                _candidates[candidateId] = candidate;
            return [.. result];
        }

        private object ConfigureTarget(int id, JsonElement body)
        {
            if (!CleanupActiveDraftIfUnchanged())
                return Error(id, "active_draft_changed", "The prior Agent draft changed and was preserved.");
            string? candidateId = StringProperty(body, "candidateId", IdentifierPattern());
            if (candidateId is null || !_candidates.TryGetValue(candidateId, out Candidate? candidate)
                || candidate.Composer is null || candidate.Send is null
                || candidate.ComposerIdentity is null || candidate.SendIdentity is null
                || candidate.InteractionRoot is null
                || !ValidateBoundInteraction(
                    candidate.ProcessId,
                    candidate.ProcessStartTicks,
                    candidate.KnownAgentSurface,
                    candidate.Window,
                    candidate.Composer,
                    candidate.Send,
                    candidate.ComposerIdentity,
                    candidate.SendIdentity,
                    candidate.InteractionRoot))
                return Error(id, "target_incompatible", "Selected Agent target is unavailable or incompatible.");
            string targetId = $"target-{Guid.NewGuid():D}";
            string label = BoundedTargetLabel(
                candidate.AppName,
                candidate.Window.Current.Name,
                candidate.Composer,
                candidate.Send);
            ResponseBinding? responseBinding = FindResponseRoot(
                candidate.InteractionRoot,
                candidate.Composer,
                candidate.Window);
            string targetGeneration = $"generation-{Guid.NewGuid():D}";
            _profile = new Profile(
                targetId,
                targetGeneration,
                candidate.ProcessId,
                candidate.ProcessStartTicks,
                candidate.KnownAgentSurface,
                label,
                candidate.Window,
                candidate.Composer,
                candidate.Send,
                candidate.ComposerIdentity,
                candidate.SendIdentity,
                candidate.InteractionRoot,
                responseBinding?.Root,
                responseBinding?.Identity);
            _armed = false;
            _activeStage = null;
            _activeProbe = null;
            _observations.Clear();
            return Result(id, TargetWire(targetId, targetGeneration, label, responseBinding is not null));
        }

        private object Arm(int id, JsonElement body)
        {
            string? targetId = StringProperty(body, "targetId", IdentifierPattern());
            if (_profile is null || targetId != _profile.TargetId || !Validate(_profile))
                return Error(id, "target_lost", "Configured Agent target is unavailable.");
            _armed = true;
            return Result(id, new { armed = true });
        }

        private object Disarm(int id)
        {
            OwnedDraftCleanupOutcome cleanup = CleanupOwnedDraft();
            _armed = false;
            _observations.Clear();
            return Result(id, new
            {
                armed = false,
                cleanupResolved = cleanup != OwnedDraftCleanupOutcome.Unresolved,
            });
        }

        private object TestDraftRoundTrip(int id, JsonElement body)
        {
            if (!TargetRequest(body, requireArmed: false, out Profile? profile)
                || StringProperty(body, "text", new Regex("^[^\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]{1,4000}$")) is not string text
                || StringProperty(body, "expectedDraftDigest", DigestPattern()) is not string expected
                || StringProperty(body, "targetGeneration", IdentifierPattern()) != profile.Generation)
                return Result(id, new { outcome = "blocked", reason = "target_lost" });
            if (!string.IsNullOrWhiteSpace(ReadValue(profile.Composer)))
                return Result(id, new { outcome = "blocked", reason = "composer_not_empty" });
            if (_activeStage is not null || _activeProbe is not null)
                return Result(id, new { outcome = "blocked", reason = "composer_not_empty" });
            // Establish cleanup ownership before SetValue. If UI Automation
            // throws after mutation, the outer catch and process-finally path
            // retain the exact digest/generation required for safe cleanup.
            _activeProbe = new ActiveProbe(expected, profile.Generation);
            if (!WriteValue(profile.Composer, text))
            {
                _ = CleanupActiveDraftIfUnchanged();
                return Result(id, new { outcome = "blocked", reason = "draft_mismatch" });
            }
            if (Sha256(ReadValue(profile.Composer)) != expected)
                return Result(id, new { outcome = "blocked", reason = "draft_mismatch" });
            if (!CleanupActiveDraftIfUnchanged())
                return Result(id, new { outcome = "blocked", reason = "cleanup_failed" });
            return Result(id, new { outcome = "passed" });
        }

        private object StageDraft(int id, JsonElement body)
        {
            if (!TargetRequest(body, requireArmed: true, out Profile? profile)
                || StringProperty(body, "stageId", IdentifierPattern()) is not string stageId
                || StringProperty(body, "text", new Regex("^[^\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]{1,4000}$")) is not string text
                || StringProperty(body, "expectedDraftDigest", DigestPattern()) is not string expected
                || StringProperty(body, "targetGeneration", IdentifierPattern()) != profile.Generation)
                return Result(id, new { outcome = "blocked", verified = false, reason = "target_lost" });
            if (_activeStage is not null || _activeProbe is not null || !string.IsNullOrWhiteSpace(ReadValue(profile.Composer)))
                return Result(id, new { outcome = "blocked", verified = false, reason = "composer_not_empty" });
            if (Sha256(text) != expected)
                return Result(id, new { outcome = "blocked", verified = false, reason = "draft_mismatch" });
            // Own the tuple before SetValue so a native exception/lost reply
            // between mutation and readback remains exactly compensatable.
            _activeStage = new ActiveStage(stageId, expected, profile.Generation);
            if (!WriteValue(profile.Composer, text) || Sha256(ReadValue(profile.Composer)) != expected)
                return Result(id, new { outcome = "blocked", verified = false, reason = "draft_mismatch" });
            return Result(id, new { outcome = "staged", verified = true, targetGeneration = profile.Generation });
        }

        private object AbortStage(int id, JsonElement body)
        {
            string? targetId = StringProperty(body, "targetId", IdentifierPattern());
            string? stageId = StringProperty(body, "stageId", IdentifierPattern());
            string? expected = StringProperty(body, "expectedDraftDigest", DigestPattern());
            string? targetGeneration = StringProperty(body, "targetGeneration", IdentifierPattern());
            Profile? profile = _profile;
            if (profile is null || targetId != profile.TargetId || targetGeneration != profile.Generation)
                return Result(id, new { outcome = "target_lost" });
            if (_activeStage is null
                || stageId != _activeStage.StageId
                || expected != _activeStage.Digest
                || targetGeneration != _activeStage.TargetGeneration)
                return Result(id, new { outcome = "not_found" });

            if (!ValidateOwnedComposer(profile)) return Result(id, new { outcome = "target_lost" });
            string current = ReadValue(profile.Composer);
            if (Sha256(current) != expected)
            {
                // Proven human/external edit: preserve it and release ownership.
                _activeStage = null;
                return Result(id, new { outcome = "draft_changed" });
            }
            if (!WriteValue(profile.Composer, ""))
                return Result(id, new { outcome = "target_lost" });
            string after = ReadValue(profile.Composer);
            if (after == "")
            {
                _activeStage = null;
                return Result(id, new { outcome = "cancelled" });
            }
            if (Sha256(after) != expected)
            {
                _activeStage = null;
                return Result(id, new { outcome = "draft_changed" });
            }
            // The exact relay draft remains. Retain ownership for disarm/EOF.
            return Result(id, new { outcome = "target_lost" });
        }

        private object ConfirmDraft(int id, JsonElement body)
        {
            if (!TargetRequest(body, requireArmed: true, out Profile? profile))
                return Result(id, new { outcome = "blocked", reason = "target_lost" });
            string? stageId = StringProperty(body, "stageId", IdentifierPattern());
            string? expected = StringProperty(body, "expectedDraftDigest", DigestPattern());
            string? targetGeneration = StringProperty(body, "targetGeneration", IdentifierPattern());
            if (_activeStage is null || stageId != _activeStage.StageId || expected != _activeStage.Digest
                || targetGeneration != _activeStage.TargetGeneration
                || targetGeneration != profile.Generation
                || Sha256(ReadValue(profile.Composer)) != expected)
                return Result(id, new { outcome = "blocked", reason = "draft_changed" });
            string sentDraft = ReadValue(profile.Composer);
            ResponseSnapshotState? baseline =
                ValidateOptionalResponseRoot(profile)
                && profile.ResponseRoot is not null
                    ? ResponseSnapshot(profile.ResponseRoot)
                    : null;
            if (!Invoke(profile.Send)) return Result(id, new { outcome = "blocked", reason = "send_unavailable" });
            _activeStage = null;
            if (baseline is null) return Result(id, new { outcome = "sent" });
            PruneObservations();
            string observationId = $"observation-{Guid.NewGuid():D}";
            _observations[observationId] = new Observation { Baseline = baseline, SentDraft = sentDraft };
            return Result(id, new { outcome = "sent", observationId });
        }

        private object CancelDraft(int id, JsonElement body)
        {
            if (!TargetRequest(body, requireArmed: true, out Profile? profile))
                return Result(id, new { outcome = "target_lost" });
            string? stageId = StringProperty(body, "stageId", IdentifierPattern());
            string? expected = StringProperty(body, "expectedDraftDigest", DigestPattern());
            string? targetGeneration = StringProperty(body, "targetGeneration", IdentifierPattern());
            if (_activeStage is null || stageId != _activeStage.StageId || expected != _activeStage.Digest
                || targetGeneration != _activeStage.TargetGeneration
                || targetGeneration != profile.Generation
                || Sha256(ReadValue(profile.Composer)) != expected)
                return Result(id, new { outcome = "draft_changed" });
            if (!WriteValue(profile.Composer, "") || ReadValue(profile.Composer) != "")
                return Result(id, new { outcome = "draft_changed" });
            _activeStage = null;
            return Result(id, new { outcome = "cancelled" });
        }

        private object ReadReply(int id, JsonElement body)
        {
            PruneObservations();
            if (!TargetRequest(body, requireArmed: true, out Profile? profile)
                || StringProperty(body, "observationId", IdentifierPattern()) is not string observationId
                || !_observations.TryGetValue(observationId, out Observation? observation))
                return Result(id, new { phase = "unavailable", sequence = 0 });
            int after = body.TryGetProperty("afterSequence", out JsonElement afterValue) && afterValue.TryGetInt32(out int parsed)
                ? Math.Max(parsed, 0) : 0;
            if (!ValidateOptionalResponseRoot(profile)
                || profile.ResponseRoot is null
                || ResponseSnapshot(profile.ResponseRoot) is not ResponseSnapshotState current)
            {
                _observations.Remove(observationId);
                return Result(id, new { phase = "unavailable", sequence = observation.Sequence });
            }
            ResponseDelta deltaResult = ResponseDeltaBetween(observation.Baseline, current, observation.SentDraft);
            if (deltaResult.Ambiguous)
            {
                _observations.Remove(observationId);
                return Result(id, new { phase = "unavailable", sequence = observation.Sequence });
            }
            string delta = deltaResult.Text;
            if (delta != observation.LastText)
            {
                observation.LastText = delta.Length > 20_000 ? delta[..20_000] : delta;
                observation.Sequence++;
                observation.StableReads = 0;
                observation.LastChangeTicks = Stopwatch.GetTimestamp();
            }
            else if (delta.Length > 0) observation.StableReads++;
            double age = (Stopwatch.GetTimestamp() - observation.LastChangeTicks) / (double)Stopwatch.Frequency;
            bool complete = observation.LastText.Length > 0 && observation.StableReads >= 2 && age >= 0.75;
            return Result(id, new
            {
                phase = observation.LastText.Length == 0 ? "waiting" : complete ? "complete" : "streaming",
                sequence = observation.Sequence,
                text = observation.Sequence > after && observation.LastText.Length > 0 ? observation.LastText : null,
            });
        }

        private void PruneObservations()
        {
            long now = Stopwatch.GetTimestamp();
            string[] expired = [.. _observations
                .Where(pair => (now - pair.Value.CreatedTicks) / (double)Stopwatch.Frequency > ObservationRetentionSeconds)
                .Select(pair => pair.Key)];
            foreach (string id in expired) _observations.Remove(id);

            int overflow = _observations.Count - (MaximumObservations - 1);
            foreach (string id in _observations
                .OrderBy(pair => pair.Value.CreatedTicks)
                .Take(Math.Max(0, overflow))
                .Select(pair => pair.Key)
                .ToArray())
                _observations.Remove(id);
        }

        private object Shutdown(int id)
        {
            OwnedDraftCleanupOutcome cleanup = CleanupOwnedDraft();
            _armed = false;
            _candidates.Clear();
            _observations.Clear();
            ShouldExit = true;
            return Result(id, new
            {
                closed = true,
                cleanupResolved = cleanup != OwnedDraftCleanupOutcome.Unresolved,
            });
        }

        private OwnedDraftCleanupOutcome CleanupOwnedDraft()
        {
            ActiveStage? activeStage = _activeStage;
            ActiveProbe? activeProbe = _activeProbe;
            if (activeStage is null && activeProbe is null) return OwnedDraftCleanupOutcome.None;
            string expectedDigest = activeStage?.Digest ?? activeProbe!.Digest;
            string expectedGeneration = activeStage?.TargetGeneration ?? activeProbe!.TargetGeneration;
            Profile? profile = _profile;
            try
            {
                if (profile is null
                    || expectedGeneration != profile.Generation
                    || !ValidateOwnedComposer(profile)) return OwnedDraftCleanupOutcome.Unresolved;
                string current = ReadValue(profile.Composer);
                if (Sha256(current) != expectedDigest)
                {
                    _activeStage = null;
                    _activeProbe = null;
                    return OwnedDraftCleanupOutcome.HumanChanged;
                }
                if (!WriteValue(profile.Composer, "")) return OwnedDraftCleanupOutcome.Unresolved;
                string after = ReadValue(profile.Composer);
                if (after == "")
                {
                    _activeStage = null;
                    _activeProbe = null;
                    return OwnedDraftCleanupOutcome.Cleared;
                }
                if (Sha256(after) == expectedDigest) return OwnedDraftCleanupOutcome.Unresolved;
                _activeStage = null;
                _activeProbe = null;
                return OwnedDraftCleanupOutcome.HumanChanged;
            }
            catch (Exception)
            {
                // Keep ownership for the next disarm/EOF attempt.
                return OwnedDraftCleanupOutcome.Unresolved;
            }
        }

        private bool CleanupActiveDraftIfUnchanged()
        {
            OwnedDraftCleanupOutcome outcome = CleanupOwnedDraft();
            return outcome is OwnedDraftCleanupOutcome.None or OwnedDraftCleanupOutcome.Cleared;
        }

        public void CleanupBeforeExit()
        {
            _ = CleanupOwnedDraft();
            _armed = false;
            _observations.Clear();
        }

        private bool TargetRequest(JsonElement body, bool requireArmed, [NotNullWhen(true)] out Profile? profile)
        {
            string? targetId = StringProperty(body, "targetId", IdentifierPattern());
            profile = _profile;
            return (!requireArmed || _armed) && profile is not null && profile.TargetId == targetId && Validate(profile);
        }
    }

    private static object Result(int id, object result) => new { jsonrpc = "2.0", id, result };
    private static object Error(int id, string code, string message) => new { jsonrpc = "2.0", id, error = new { code, message } };
    private static object TargetWire(string targetId, string targetGeneration, string label, bool replyObservation) => new
    {
        targetId,
        targetGeneration,
        label,
        capabilities = new { draftInsertion = true, explicitSend = true, replyObservation },
    };

    private static bool Validate(Profile profile)
    {
        try
        {
            return ValidateBoundInteraction(
                profile.ProcessId,
                profile.ProcessStartTicks,
                profile.KnownAgentSurface,
                profile.Window,
                profile.Composer,
                profile.Send,
                profile.ComposerIdentity,
                profile.SendIdentity,
                profile.InteractionRoot);
        }
        catch (ArgumentException) { return false; }
    }

    private static bool ValidateOwnedComposer(Profile profile)
    {
        try
        {
            using Process process = Process.GetProcessById(profile.ProcessId);
            return !process.HasExited
                && process.StartTime.ToUniversalTime().Ticks == profile.ProcessStartTicks
                && profile.Window.Current.ProcessId == profile.ProcessId
                && profile.Composer.Current.ProcessId == profile.ProcessId
                && MatchesStableIdentity(profile.Composer, profile.ComposerIdentity)
                && IsAgentComposer(profile.Composer, profile.KnownAgentSurface);
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (ElementNotAvailableException) { return false; }
    }

    private static bool IsWritable(AutomationElement element) =>
        element.TryGetCurrentPattern(ValuePattern.Pattern, out object pattern)
        && pattern is ValuePattern value
        && !value.Current.IsReadOnly
        && element.Current.IsEnabled
        && !element.Current.IsPassword;

    private static bool SameElementIdentity(AutomationElement? left, AutomationElement? right)
    {
        if (left is null || right is null) return left is null && right is null;
        try
        {
            return left.Current.ProcessId == right.Current.ProcessId
                && left.GetRuntimeId().SequenceEqual(right.GetRuntimeId());
        }
        catch (ElementNotAvailableException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static bool IsForbiddenApplication(string processName)
    {
        string identity = processName.ToLowerInvariant();
        return new[]
        {
            "semaframe", "windowsterminal", "openconsole", "powershell", "pwsh",
            "cmd", "conhost", "credentialuibroker", "consent", "systemsettings", "winlogon",
        }.Any(forbidden => identity.Contains(forbidden, StringComparison.Ordinal));
    }

    private static bool IsKnownAgentApplication(string processName) =>
        processName.Equals("chatgpt", StringComparison.OrdinalIgnoreCase)
        || processName.Equals("codex", StringComparison.OrdinalIgnoreCase);

    private static bool SupportsInvoke(AutomationElement element) =>
        element.TryGetCurrentPattern(InvokePattern.Pattern, out _) && element.Current.IsEnabled;

    private static string ReadValue(AutomationElement element) =>
        element.TryGetCurrentPattern(ValuePattern.Pattern, out object pattern) && pattern is ValuePattern value
            ? value.Current.Value ?? "" : "";

    private static bool WriteValue(AutomationElement element, string value)
    {
        if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out object pattern) || pattern is not ValuePattern editable || editable.Current.IsReadOnly)
            return false;
        editable.SetValue(value);
        return true;
    }

    private static bool Invoke(AutomationElement element)
    {
        if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out object pattern) || pattern is not InvokePattern invoke) return false;
        invoke.Invoke();
        return true;
    }

    private static bool ContainsSemanticToken(string text, params string[] tokens)
    {
        foreach (string token in tokens)
        {
            if (Regex.IsMatch(
                text,
                $"(?:^|[^a-z0-9]){Regex.Escape(token)}(?:[^a-z0-9]|$)",
                RegexOptions.CultureInvariant)) return true;
        }
        return false;
    }

    private static string SearchableText(AutomationElement element) =>
        $"{element.Current.AutomationId} {element.Current.Name} {element.Current.HelpText}".ToLowerInvariant();

    private static ControlIdentity? StableControlIdentity(
        AutomationElement element,
        bool allowSemanticFallback = false)
    {
        string automationId = element.Current.AutomationId.Trim();
        int[] runtimeId = element.GetRuntimeId();
        string controlTypeName = element.Current.ControlType.ProgrammaticName;
        if (automationId.Length > 0) automationId = $"automation-id:{automationId}";
        else if (allowSemanticFallback)
        {
            string name = element.Current.Name.Trim();
            string help = element.Current.HelpText.Trim();
            if (name.Length > 0) automationId = $"semantic:name:{name}";
            else if (help.Length > 0) automationId = $"semantic:help:{help}";
        }
        return automationId.Length is > 0 and <= 256 && runtimeId.Length > 0 && controlTypeName.Length > 0
            ? new ControlIdentity(automationId, runtimeId, controlTypeName)
            : null;
    }

    private static bool MatchesStableIdentity(AutomationElement element, ControlIdentity expected)
    {
        ControlIdentity? current = StableControlIdentity(
            element,
            expected.AutomationId.StartsWith("semantic:", StringComparison.Ordinal));
        return current is not null
            && StringComparer.Ordinal.Equals(current.AutomationId, expected.AutomationId)
            && StringComparer.Ordinal.Equals(current.ControlTypeName, expected.ControlTypeName)
            && current.RuntimeId.SequenceEqual(expected.RuntimeId);
    }

    private static bool IsAgentComposer(AutomationElement element, bool knownAgentSurface)
    {
        ControlType type = element.Current.ControlType;
        if ((type != ControlType.Edit && type != ControlType.Document)
            || !IsWritable(element)
            || StableControlIdentity(element, allowSemanticFallback: true) is null) return false;
        string text = SearchableText(element);
        bool semanticMatch = ContainsSemanticToken(text, "message", "prompt", "composer", "chat", "ask")
            || knownAgentSurface && text.Contains("do anything", StringComparison.Ordinal);
        return semanticMatch
            && !ContainsSemanticToken(text, "search", "filter", "find", "password", "credential");
    }

    private static bool IsExplicitSendControl(AutomationElement element)
    {
        if (element.Current.ControlType != ControlType.Button
            || !SupportsInvoke(element)
            || StableControlIdentity(element, allowSemanticFallback: true) is null) return false;
        string text = SearchableText(element);
        return ContainsSemanticToken(text, "send", "submit")
            && !ContainsSemanticToken(text, "stop", "cancel", "delete", "close", "feedback", "report", "invite", "share");
    }

    private static List<(AutomationElement Element, int Depth)> ParentChain(AutomationElement element, int maximumDepth = 12)
    {
        var result = new List<(AutomationElement Element, int Depth)>();
        AutomationElement current = element;
        for (int depth = 1; depth <= maximumDepth; depth++)
        {
            AutomationElement? parent = TreeWalker.RawViewWalker.GetParent(current);
            if (parent is null || result.Any(item => SameElementIdentity(item.Element, parent))) break;
            result.Add((parent, depth));
            current = parent;
        }
        return result;
    }

    private static (AutomationElement Root, int ComposerDepth, int SendDepth)? NearestCommonInteractionRoot(
        AutomationElement composer,
        AutomationElement send,
        AutomationElement window)
    {
        List<(AutomationElement Element, int Depth)> composerParents = ParentChain(composer);
        List<(AutomationElement Element, int Depth)> sendParents = ParentChain(send);
        (AutomationElement Root, int ComposerDepth, int SendDepth)? best = null;
        foreach ((AutomationElement composerParent, int composerDepth) in composerParents)
        {
            if (composerDepth > 6 || SameElementIdentity(composerParent, window)) continue;
            foreach ((AutomationElement sendParent, int sendDepth) in sendParents)
            {
                if (sendDepth > 6 || composerDepth + sendDepth > 10
                    || !SameElementIdentity(composerParent, sendParent)) continue;
                if (best is null || composerDepth + sendDepth < best.Value.ComposerDepth + best.Value.SendDepth)
                    best = (composerParent, composerDepth, sendDepth);
            }
        }
        return best;
    }

    private static bool IsFinitePositiveRect(System.Windows.Rect value) =>
        double.IsFinite(value.X)
        && double.IsFinite(value.Y)
        && double.IsFinite(value.Width)
        && double.IsFinite(value.Height)
        && value.Width > 0
        && value.Height > 0;

    private static double RectGap(System.Windows.Rect left, System.Windows.Rect right)
    {
        double horizontal = Math.Max(0, Math.Max(left.Left - right.Right, right.Left - left.Right));
        double vertical = Math.Max(0, Math.Max(left.Top - right.Bottom, right.Top - left.Bottom));
        return Math.Sqrt(horizontal * horizontal + vertical * vertical);
    }

    private static bool FrameContains(System.Windows.Rect outer, System.Windows.Rect inner, double tolerance = 4) =>
        inner.Left >= outer.Left - tolerance
        && inner.Top >= outer.Top - tolerance
        && inner.Right <= outer.Right + tolerance
        && inner.Bottom <= outer.Bottom + tolerance;

    private static bool HasDefensibleInteractionGeometry(
        AutomationElement composer,
        AutomationElement send,
        AutomationElement interactionRoot,
        AutomationElement window)
    {
        System.Windows.Rect composerFrame = composer.Current.BoundingRectangle;
        System.Windows.Rect sendFrame = send.Current.BoundingRectangle;
        System.Windows.Rect rootFrame = interactionRoot.Current.BoundingRectangle;
        System.Windows.Rect windowFrame = window.Current.BoundingRectangle;
        if (!IsFinitePositiveRect(composerFrame)
            || !IsFinitePositiveRect(sendFrame)
            || !IsFinitePositiveRect(rootFrame)
            || !IsFinitePositiveRect(windowFrame)
            || composer.Current.IsOffscreen
            || send.Current.IsOffscreen
            || composerFrame.Width < 20
            || composerFrame.Height < 16
            || sendFrame.Width > 240
            || sendFrame.Height > 160
            || !FrameContains(rootFrame, composerFrame)
            || !FrameContains(rootFrame, sendFrame)) return false;

        // A window-sized common ancestor proves only co-location in a window,
        // not that this exact Send control belongs to this composer.
        if (rootFrame.Width >= windowFrame.Width * 0.92
            && rootFrame.Height >= windowFrame.Height * 0.92) return false;
        double allowedGap = Math.Min(220, Math.Max(96, composerFrame.Height * 2.5));
        if (RectGap(composerFrame, sendFrame) > allowedGap) return false;
        return sendFrame.Left + sendFrame.Width / 2 >= composerFrame.Left - 220
            && sendFrame.Left + sendFrame.Width / 2 <= composerFrame.Right + 220
            && sendFrame.Top + sendFrame.Height / 2 >= composerFrame.Top - 160
            && sendFrame.Top + sendFrame.Height / 2 <= composerFrame.Bottom + 160;
    }

    private static (AutomationElement Root, int Score)? BoundInteraction(
        AutomationElement composer,
        AutomationElement send,
        AutomationElement window)
    {
        (AutomationElement Root, int ComposerDepth, int SendDepth)? common =
            NearestCommonInteractionRoot(composer, send, window);
        if (common is null || !HasDefensibleInteractionGeometry(composer, send, common.Value.Root, window)) return null;
        double gap = RectGap(composer.Current.BoundingRectangle, send.Current.BoundingRectangle);
        int proximity = Math.Max(0, 220 - (int)Math.Round(gap));
        int ancestry = Math.Max(0, 120 - (common.Value.ComposerDepth + common.Value.SendDepth) * 12);
        return (common.Value.Root, proximity + ancestry);
    }

    private static bool ValidateBoundInteraction(
        int processId,
        long processStartTicks,
        bool knownAgentSurface,
        AutomationElement window,
        AutomationElement composer,
        AutomationElement send,
        ControlIdentity composerIdentity,
        ControlIdentity sendIdentity,
        AutomationElement interactionRoot)
    {
        using Process process = Process.GetProcessById(processId);
        if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != processStartTicks
            || window.Current.ProcessId != processId
            || composer.Current.ProcessId != processId
            || send.Current.ProcessId != processId
            || interactionRoot.Current.ProcessId != processId
            || !MatchesStableIdentity(composer, composerIdentity)
            || !MatchesStableIdentity(send, sendIdentity)
            || !IsAgentComposer(composer, knownAgentSurface)
            || !IsExplicitSendControl(send)) return false;
        (AutomationElement Root, int Score)? current = BoundInteraction(composer, send, window);
        return current is not null && SameElementIdentity(current.Value.Root, interactionRoot);
    }

    private static BoundControls? FindControls(AutomationElement root, bool knownAgentSurface)
    {
        var queue = new Queue<(AutomationElement Element, int Depth)>();
        queue.Enqueue((root, 0));
        var composers = new List<(AutomationElement Element, int Score)>();
        var sends = new List<(AutomationElement Element, int Score)>();
        int visited = 0;
        while (queue.Count > 0 && visited++ < 5_000)
        {
            (AutomationElement element, int depth) = queue.Dequeue();
            ControlType type = element.Current.ControlType;
            string text = SearchableText(element);
            if ((type == ControlType.Edit || type == ControlType.Document)
                && IsAgentComposer(element, knownAgentSurface))
            {
                int score = type == ControlType.Document ? 20 : 10;
                if (ContainsSemanticToken(text, "message", "prompt", "composer", "chat", "ask")) score += 80;
                composers.Add((element, score));
            }
            if (type == ControlType.Button && IsExplicitSendControl(element))
            {
                sends.Add((element, ContainsSemanticToken(text, "send") ? 120 : 100));
            }
            if (depth >= 40) continue;
            AutomationElement? child = TreeWalker.RawViewWalker.GetFirstChild(element);
            int children = 0;
            while (child is not null && children++ < 100)
            {
                queue.Enqueue((child, depth + 1));
                child = TreeWalker.RawViewWalker.GetNextSibling(child);
            }
        }
        var candidates = new List<BoundControls>();
        foreach ((AutomationElement composer, int composerScore) in composers)
        {
            foreach ((AutomationElement send, int sendScore) in sends)
            {
                ControlIdentity? composerIdentity = StableControlIdentity(composer, allowSemanticFallback: true);
                ControlIdentity? sendIdentity = StableControlIdentity(send, allowSemanticFallback: true);
                (AutomationElement Root, int Score)? binding = BoundInteraction(composer, send, root);
                if (composerIdentity is null || sendIdentity is null || binding is null) continue;
                candidates.Add(new BoundControls(
                    composer,
                    send,
                    composerIdentity,
                    sendIdentity,
                    binding.Value.Root,
                    composerScore + sendScore + binding.Value.Score));
            }
        }
        BoundControls[] ranked = [.. candidates.OrderByDescending(candidate => candidate.Score)];
        if (ranked.Length == 0) return null;
        if (ranked.Length > 1)
        {
            BoundControls best = ranked[0], runnerUp = ranked[1];
            bool sameExactPair = SameElementIdentity(best.Composer, runnerUp.Composer)
                && SameElementIdentity(best.Send, runnerUp.Send)
                && SameElementIdentity(best.InteractionRoot, runnerUp.InteractionRoot);
            if (best.Score - runnerUp.Score < ControlPairAmbiguityMargin && !sameExactPair)
                return null;
        }
        return ranked[0];
    }

    private static bool IsDescendantOf(AutomationElement element, AutomationElement ancestor, int maximumDepth = 12)
    {
        if (SameElementIdentity(element, ancestor)) return true;
        AutomationElement current = element;
        for (int index = 0; index < maximumDepth; index++)
        {
            AutomationElement? parent = TreeWalker.RawViewWalker.GetParent(current);
            if (parent is null) return false;
            if (SameElementIdentity(parent, ancestor)) return true;
            current = parent;
        }
        return false;
    }

    private static bool ResponseRootHasSemantics(AutomationElement element)
    {
        ControlType type = element.Current.ControlType;
        if (type == ControlType.Button || type == ControlType.Edit || type == ControlType.Document
            || type == ControlType.Text || StableControlIdentity(element) is null) return false;
        return ContainsSemanticToken(
            SearchableText(element),
            "conversation", "messages", "responses", "transcript", "thread", "history");
    }

    private static bool ResponseRootIsTiedToInteraction(
        AutomationElement responseRoot,
        AutomationElement interactionRoot,
        AutomationElement composer,
        AutomationElement window)
    {
        if (IsDescendantOf(responseRoot, interactionRoot)
            || IsDescendantOf(interactionRoot, responseRoot)
            || NearestCommonInteractionRoot(responseRoot, interactionRoot, window) is null) return false;
        System.Windows.Rect responseFrame = responseRoot.Current.BoundingRectangle;
        System.Windows.Rect composerFrame = composer.Current.BoundingRectangle;
        System.Windows.Rect windowFrame = window.Current.BoundingRectangle;
        if (!IsFinitePositiveRect(responseFrame)
            || !IsFinitePositiveRect(composerFrame)
            || !IsFinitePositiveRect(windowFrame)
            || responseFrame.Height < 100
            || responseFrame.Width < Math.Min(240, composerFrame.Width * 0.6)
            || responseFrame.Bottom > composerFrame.Bottom + 40) return false;
        double overlap = Math.Max(0, Math.Min(responseFrame.Right, composerFrame.Right) - Math.Max(responseFrame.Left, composerFrame.Left));
        if (overlap < Math.Min(responseFrame.Width, composerFrame.Width) * 0.4) return false;
        return !(responseFrame.Width >= windowFrame.Width * 0.92
            && responseFrame.Height >= windowFrame.Height * 0.92);
    }

    private static ResponseMessageKind? ResponseKind(AutomationElement element)
    {
        string text = SearchableText(element);
        if (ContainsSemanticToken(text, "assistant", "response", "agent")) return ResponseMessageKind.Assistant;
        if (ContainsSemanticToken(text, "user", "human")) return ResponseMessageKind.User;
        if (ContainsSemanticToken(text, "message")) return ResponseMessageKind.Ambiguous;
        return null;
    }

    private static string ResponseMessageKey(ControlIdentity identity) =>
        $"{identity.ControlTypeName}\u001f{identity.AutomationId}\u001f{string.Join(".", identity.RuntimeId)}";

    private static string BoundedText(AutomationElement root)
    {
        var parts = new List<string>();
        var queue = new Queue<(AutomationElement Element, int Depth)>();
        queue.Enqueue((root, 0));
        int visited = 0, characters = 0;
        while (queue.Count > 0 && visited++ < 5_000 && characters < 20_000)
        {
            (AutomationElement element, int depth) = queue.Dequeue();
            string value = "";
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out object textPattern) && textPattern is TextPattern text)
                value = text.DocumentRange.GetText(20_000 - characters);
            else if (element.Current.ControlType == ControlType.Text) value = element.Current.Name;
            value = value.Trim();
            if (value.Length > 0) { parts.Add(value); characters += value.Length + 1; }
            if (depth >= 40) continue;
            AutomationElement? child = TreeWalker.RawViewWalker.GetFirstChild(element);
            int children = 0;
            while (child is not null && children++ < 120)
            {
                queue.Enqueue((child, depth + 1));
                child = TreeWalker.RawViewWalker.GetNextSibling(child);
            }
        }
        string result = string.Join("\n", parts);
        return result.Length > 20_000 ? result[..20_000] : result;
    }

    private static ResponseSnapshotState? ResponseSnapshot(AutomationElement root)
    {
        var messages = new Dictionary<string, ResponseMessage>(StringComparer.Ordinal);
        var order = new List<string>();
        var queue = new Queue<(AutomationElement Element, int Depth)>();
        AutomationElement? initial = TreeWalker.RawViewWalker.GetFirstChild(root);
        int initialCount = 0;
        while (initial is not null && initialCount++ < 120)
        {
            queue.Enqueue((initial, 1));
            initial = TreeWalker.RawViewWalker.GetNextSibling(initial);
        }
        int visited = 0, characters = 0;
        while (queue.Count > 0 && visited++ < 5_000 && characters < 20_000)
        {
            (AutomationElement element, int depth) = queue.Dequeue();
            ResponseMessageKind? kind = ResponseKind(element);
            ControlIdentity? identity = StableControlIdentity(element);
            if (kind is not null && identity is not null)
            {
                string text = BoundedText(element).Trim();
                if (text.Length > 0)
                {
                    string key = ResponseMessageKey(identity);
                    if (messages.ContainsKey(key)) return null;
                    messages[key] = new ResponseMessage(kind.Value, text);
                    order.Add(key);
                    characters += text.Length;
                    continue;
                }
            }
            if (depth >= 20) continue;
            AutomationElement? child = TreeWalker.RawViewWalker.GetFirstChild(element);
            int children = 0;
            while (child is not null && children++ < 120)
            {
                queue.Enqueue((child, depth + 1));
                child = TreeWalker.RawViewWalker.GetNextSibling(child);
            }
        }
        return messages.Count > 0 ? new ResponseSnapshotState(messages, order) : null;
    }

    private static ResponseBinding? FindResponseRoot(
        AutomationElement interactionRoot,
        AutomationElement composer,
        AutomationElement window)
    {
        var candidates = new List<(AutomationElement Root, ControlIdentity Identity, int Score)>();
        var queue = new Queue<(AutomationElement Element, int Depth)>();
        queue.Enqueue((window, 0));
        int visited = 0;
        while (queue.Count > 0 && visited++ < 5_000)
        {
            (AutomationElement element, int depth) = queue.Dequeue();
            if (SameElementIdentity(element, interactionRoot)) continue;
            ControlIdentity? identity = StableControlIdentity(element);
            if (identity is not null
                && ResponseRootHasSemantics(element)
                && ResponseRootIsTiedToInteraction(element, interactionRoot, composer, window)
                && ResponseSnapshot(element) is not null)
            {
                System.Windows.Rect frame = element.Current.BoundingRectangle;
                int semanticScore = ContainsSemanticToken(SearchableText(element), "responses", "messages") ? 180 : 140;
                int localityScore = Math.Max(0, 200 - (int)(frame.Height / 10));
                candidates.Add((element, identity, semanticScore + localityScore));
            }
            if (depth >= 30) continue;
            AutomationElement? child = TreeWalker.RawViewWalker.GetFirstChild(element);
            int children = 0;
            while (child is not null && children++ < 120)
            {
                queue.Enqueue((child, depth + 1));
                child = TreeWalker.RawViewWalker.GetNextSibling(child);
            }
        }
        (AutomationElement Root, ControlIdentity Identity, int Score)[] ranked = [.. candidates.OrderByDescending(candidate => candidate.Score)];
        if (ranked.Length == 0) return null;
        if (ranked.Length > 1
            && ranked[0].Score - ranked[1].Score < 24
            && !IsDescendantOf(ranked[0].Root, ranked[1].Root)
            && !IsDescendantOf(ranked[1].Root, ranked[0].Root)) return null;
        return new ResponseBinding(ranked[0].Root, ranked[0].Identity);
    }

    private static bool ValidateOptionalResponseRoot(Profile profile)
    {
        if (profile.ResponseRoot is null || profile.ResponseRootIdentity is null)
            return profile.ResponseRoot is null && profile.ResponseRootIdentity is null;
        return profile.ResponseRoot.Current.ProcessId == profile.ProcessId
            && MatchesStableIdentity(profile.ResponseRoot, profile.ResponseRootIdentity)
            && ResponseRootHasSemantics(profile.ResponseRoot)
            && ResponseRootIsTiedToInteraction(
                profile.ResponseRoot,
                profile.InteractionRoot,
                profile.Composer,
                profile.Window);
    }

    private static ResponseDelta ResponseDeltaBetween(
        ResponseSnapshotState baseline,
        ResponseSnapshotState current,
        string sentDraft)
    {
        if (baseline.Messages.Keys.Any(key => !current.Messages.ContainsKey(key))) return new ResponseDelta(true, "");
        string[] retainedOrder = [.. current.Order.Where(key => baseline.Messages.ContainsKey(key))];
        if (!retainedOrder.SequenceEqual(baseline.Order, StringComparer.Ordinal)) return new ResponseDelta(true, "");
        int baselineTailIndex = baseline.Order.Count == 0 ? -1 : current.Order.ToList().IndexOf(baseline.Order[^1]);
        var replies = new List<string>();
        bool sawUserEcho = false;
        bool sawAssistant = false;
        for (int index = 0; index < current.Order.Count; index++)
        {
            string key = current.Order[index];
            if (!current.Messages.TryGetValue(key, out ResponseMessage? message) || message is null)
                return new ResponseDelta(true, "");
            baseline.Messages.TryGetValue(key, out ResponseMessage? prior);
            if (prior is not null && prior.Kind != message.Kind) return new ResponseDelta(true, "");
            if (prior?.Text == message.Text) continue;
            if (prior is not null || index <= baselineTailIndex) return new ResponseDelta(true, "");
            if (message.Kind is ResponseMessageKind.User or ResponseMessageKind.Ambiguous)
            {
                if (sawUserEcho || sawAssistant || message.Text != sentDraft) return new ResponseDelta(true, "");
                sawUserEcho = true;
                continue;
            }
            string reply = message.Text.Trim();
            if (reply.Length == 0 || reply == sentDraft) return new ResponseDelta(true, "");
            sawAssistant = true;
            replies.Add(reply.Length > 20_000 ? reply[..20_000] : reply);
        }
        return replies.Count switch
        {
            0 => new ResponseDelta(false, ""),
            1 => new ResponseDelta(false, replies[0]),
            _ => new ResponseDelta(true, ""),
        };
    }

    private static string BoundedLabel(string? value)
    {
        string label = string.IsNullOrWhiteSpace(value) ? "Agent window" : value.Trim();
        return label.Length > 160 ? label[..160] : label;
    }

    private static string ControlLabel(AutomationElement element, string fallback)
    {
        string label = element.Current.Name;
        if (string.IsNullOrWhiteSpace(label)) label = element.Current.HelpText;
        return BoundedLabel(string.IsNullOrWhiteSpace(label) ? fallback : label);
    }

    private static string BoundedTargetLabel(
        string appName,
        string windowTitle,
        AutomationElement composer,
        AutomationElement send)
    {
        string app = BoundedLabel(appName)[..Math.Min(32, BoundedLabel(appName).Length)];
        string window = BoundedLabel(windowTitle)[..Math.Min(48, BoundedLabel(windowTitle).Length)];
        string composerLabel = ControlLabel(composer, "Agent composer");
        composerLabel = composerLabel[..Math.Min(24, composerLabel.Length)];
        string sendLabel = ControlLabel(send, "Send");
        sendLabel = sendLabel[..Math.Min(20, sendLabel.Length)];
        return BoundedLabel($"{app} — {window} [{composerLabel} → {sendLabel}]");
    }
}

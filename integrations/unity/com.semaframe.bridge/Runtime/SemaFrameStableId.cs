using UnityEngine;

namespace SemaFrame.Bridge
{
    [DisallowMultipleComponent]
    public sealed class SemaFrameStableId : MonoBehaviour
    {
        [SerializeField] private string stableId = "";
        [SerializeField] private Vector3 baselinePosition;
        [SerializeField] private Quaternion baselineRotation = Quaternion.identity;
        [SerializeField] private Vector3 baselineScale = Vector3.one;

        public string StableId => stableId;

        public void Assign(string value)
        {
            stableId = value ?? "";
        }

        public void CaptureBaseline()
        {
            baselinePosition = transform.localPosition;
            baselineRotation = transform.localRotation;
            baselineScale = transform.localScale;
        }

        public bool HasTransformChanged(float tolerance = 0.00001f)
        {
            return (transform.localPosition - baselinePosition).sqrMagnitude > tolerance * tolerance ||
                   1f - Mathf.Abs(Quaternion.Dot(transform.localRotation, baselineRotation)) > tolerance ||
                   (transform.localScale - baselineScale).sqrMagnitude > tolerance * tolerance;
        }
    }

    [DisallowMultipleComponent]
    public sealed class SemaFrameBridgeSource : MonoBehaviour
    {
        [SerializeField] private string workspaceId = "";
        [SerializeField] private int baseRevision;
        [SerializeField] private string exchangeDigest = "";

        public string WorkspaceId => workspaceId;
        public int BaseRevision => baseRevision;
        public string ExchangeDigest => exchangeDigest;

        public void Assign(string workspace, int revision, string digest)
        {
            workspaceId = workspace ?? "";
            baseRevision = revision;
            exchangeDigest = digest ?? "";
        }
    }
}

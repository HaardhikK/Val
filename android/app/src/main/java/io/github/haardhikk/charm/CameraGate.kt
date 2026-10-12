package io.github.haardhikk.charm

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.webkit.PermissionRequest

/** Which WebView media requests Charm grants: the rear camera only, and only to its own bundled page (pure, tested). */
object CameraPolicy {
    /** Same value as [PermissionRequest.RESOURCE_VIDEO_CAPTURE]. */
    const val VIDEO_CAPTURE = "android.webkit.resource.VIDEO_CAPTURE"

    fun allows(scheme: String?, host: String?, resources: Array<String>, assetHost: String): Boolean =
        scheme == "https" && host == assetHost && resources.isNotEmpty() && resources.all { it == VIDEO_CAPTURE }
}

/**
 * Bridges the page's getUserMedia call to Android's CAMERA permission: grants video capture to our own page,
 * asks the user for the permission the first time, and refuses everything else (microphone, other origins).
 */
class CameraGate(private val activity: Activity, private val assetHost: String) {

    private var pending: PermissionRequest? = null

    /** From WebChromeClient.onPermissionRequest. */
    fun onPermissionRequest(request: PermissionRequest) {
        if (!CameraPolicy.allows(request.origin.scheme, request.origin.host, request.resources, assetHost)) {
            request.deny()
            return
        }
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(CameraPolicy.VIDEO_CAPTURE))
            return
        }
        pending?.deny()
        pending = request
        activity.requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
    }

    /** From WebChromeClient.onPermissionRequestCanceled. */
    fun onPermissionRequestCanceled(request: PermissionRequest) {
        if (pending == request) pending = null
    }

    /** From Activity.onRequestPermissionsResult; true when it was the camera prompt. */
    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray): Boolean {
        if (requestCode != REQ_CAMERA) return false
        val request = pending ?: return true
        pending = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            request.grant(arrayOf(CameraPolicy.VIDEO_CAPTURE))
        } else {
            request.deny()
        }
        return true
    }

    companion object {
        const val REQ_CAMERA = 8
    }
}

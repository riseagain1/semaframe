"""Unreal startup hook for the SemaFrame Bridge content plugin."""

import unreal

import semaframe_bridge


unreal.log("SemaFrame Bridge 1.0.0 loaded; use semaframe_bridge.connect_from_environment() to consume setup JSON")

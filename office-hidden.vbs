' Launches the office (one-shot, no restart loop) with NO visible window.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = fso.BuildPath(scriptDir, "office-run.bat")
' 0 = hidden window, False = don't wait
CreateObject("WScript.Shell").Run """" & bat & """", 0, False

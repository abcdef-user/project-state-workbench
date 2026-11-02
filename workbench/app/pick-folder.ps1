Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$projectPicker = New-Object System.Windows.Forms.FolderBrowserDialog
$projectPicker.Description = '选择项目文件夹；也可以在这里新建文件夹。'
$projectPicker.ShowNewFolderButton = $true
if ($projectPicker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    @{workspaceRoot=$projectPicker.SelectedPath} | ConvertTo-Json -Compress
} else {
    @{canceled=$true} | ConvertTo-Json -Compress
}
$projectPicker.Dispose()

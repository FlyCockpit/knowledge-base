param([string]$Target, [string]$Action)
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $Target
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($Action -eq 'broaden') {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.SecurityIdentifier]'S-1-1-0', 'Read', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Target -AclObject $acl
    exit 0
}
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { exit 1 }
$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($rules.Count -eq 0) { exit 2 }
foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference -ne $sid) { exit 3 }
}
exit 0

# Data retention matrix

Northwind Systems, IT. (Fictional sample document.)

How long each class of data is kept before deletion.

| Data class | Retention | Notes |
| --- | --- | --- |
| Customer application logs | **90 days** | Rolling deletion, no exceptions without a legal hold. |
| Security and audit logs | 400 days | Required for the annual audit. |
| Support tickets | 3 years after close | Attachments deleted with the ticket. |
| Backups | 35 days | Point-in-time restore inside 7 days. |
| Employee records | 6 years after leaving | Statutory. |

A legal hold overrides every row above. Holds are placed by legal and released by legal;
nobody else may extend or shorten a retention period.

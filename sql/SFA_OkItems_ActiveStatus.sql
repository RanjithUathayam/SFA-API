/* =============================================================================
   SFA - Set OITM.U_SFAItemActiveStatus = 'No' and U_SFATriggerStatus = 'N'
         for OK items (Stock + Open PO + Open JO >= required min qty)
   -----------------------------------------------------------------------------
   Counterpart of SFA_NotOkItems_ActiveStatus.sql.
   U_SFATriggerStatus = 'N' makes the Node "Product API Sync" scheduler
   (dbService.getNextPendingProductTrigger) push the item to Salesforce as
   active on its next run; on success it flips U_SFATriggerStatus to 'Y'.

   PART 1  Audit log table            (run once)
   PART 2  Stored procedure           (run once / re-run to redeploy)
   PART 3  Manual verification        (run before enabling the job)
   PART 4  SQL Server Agent job       (run once - every 3 hours)
   ============================================================================= */


/* =============================================================================
   PART 1 - Audit log table: one row per item actually changed
   ============================================================================= */
USE [BBLive];
GO

IF OBJECT_ID(N'dbo.Z_SFA_ItemOkStatusLog', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Z_SFA_ItemOkStatusLog
    (
        LogId          INT IDENTITY(1,1) NOT NULL
                       CONSTRAINT PK_Z_SFA_ItemOkStatusLog PRIMARY KEY,
        RunAt          DATETIME2(0)  NOT NULL
                       CONSTRAINT DF_Z_SFA_ItemOkStatusLog_RunAt DEFAULT SYSDATETIME(),
        ItemCode       NVARCHAR(50)  NOT NULL,
        OldValue       NVARCHAR(254) NULL,
        NewValue       NVARCHAR(254) NULL,
        OldTrigger     NVARCHAR(254) NULL,
        NewTrigger     NVARCHAR(254) NULL
    );
END
GO


/* =============================================================================
   PART 2 - Stored procedure
     @PreviewOnly = 1 : list OK items with current values + planned action,
                        NO update.
     @PreviewOnly = 0 : update only OK items whose U_SFAItemActiveStatus is not
                        already exactly 'No' (covers 'Yes', NULL, '', other).
                        Items already 'No' are left alone so an item that was
                        synced (trigger 'Y') is not re-queued every run.
   ============================================================================= */
USE [BBLive];
GO

CREATE OR ALTER PROCEDURE dbo.usp_SFA_SetOkItemsActiveStatus
    @PreviewOnly BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    /* COLLATE DATABASE_DEFAULT avoids tempdb vs BBLive collation conflicts */
    CREATE TABLE #Ok
    (
        ItemCode NVARCHAR(50) COLLATE DATABASE_DEFAULT NOT NULL PRIMARY KEY
    );

    /* ---- Existing OK logic - UNCHANGED (only ORDER BY / output cols dropped) ---- */
    WITH BomLines AS (
        SELECT T1.Father, T1.Code AS CompCode
        FROM [BBLive].[dbo].[ITT1] AS T1
        INNER JOIN [BBLive].[dbo].[OITM] AS C ON T1.Code = C.ItemCode
        LEFT JOIN [BBLive].[dbo].[OITB] AS G ON C.ItmsGrpCod = G.ItmsGrpCod
        WHERE T1.Type = 4
          AND ISNULL(G.ItmsGrpNam, '') NOT LIKE '%ACCESS%'
          AND ISNULL(C.ItemName, '') NOT LIKE '%ACCES%'
          AND ISNULL(C.ItemName, '') NOT LIKE '%SAMPLE PAD%'
    ),
    BomCount AS (
        SELECT Father, CompCode,
               COUNT(*) OVER (PARTITION BY Father) AS BomCnt
        FROM BomLines
    ),
    Result AS (
        SELECT I.ItemCode, I.ItemName,
               ISNULL(B.BomCnt, 0) AS BomCnt,
               CASE WHEN B.BomCnt >= 2 THEN B.CompCode ELSE I.ItemCode END AS ResultCode
        FROM [BBLive].[dbo].[OITM] AS I
        LEFT JOIN BomCount AS B ON I.ItemCode = B.Father
        WHERE I.validFor = 'Y'
    ),
    PO AS (
        SELECT ItemCode, SUM(openpoqty) AS PO_OpenQty
        FROM [BBLive].[dbo].[POOPENITEMS]
        GROUP BY ItemCode
    ),
    JO AS (
        SELECT U_ItemCode, SUM(PENDQTY) AS JO_OpenQty
        FROM [BBLive].[dbo].[joopenitems]
        GROUP BY U_ItemCode
    ),
    Base AS (
        SELECT R.ItemCode,
               S.U_SubGrp5,
               ISNULL(S.OnHand, 0)
                 + ISNULL(P.PO_OpenQty, 0)
                 + ISNULL(J.JO_OpenQty, 0) AS TotalQty
        FROM Result AS R
        INNER JOIN [BBLive].[dbo].[OITM] AS S ON R.ResultCode = S.ItemCode
        LEFT JOIN PO AS P ON R.ResultCode = P.ItemCode
        LEFT JOIN JO AS J ON R.ResultCode = J.U_ItemCode
        WHERE ISNULL(S.ItemName, '') NOT LIKE '%ACCES%'
          AND ISNULL(S.ItemName, '') NOT LIKE '%SAMPLE PAD%'
          AND S.validFor = 'Y'
          AND S.U_SubGrp1 NOT LIKE '%acce%'
          AND S.U_SFAItemActiveStatus = 'YES'
    ),
    Final AS (
        SELECT B.ItemCode, B.TotalQty,
               CASE
                   WHEN TRY_CAST(LTRIM(RTRIM(CAST(B.U_SubGrp5 AS VARCHAR(20)))) AS DECIMAL(10,2))
                        IN (44, 46, 48, 50)
                       THEN 5
                   ELSE 10
               END AS ReqQty
        FROM Base AS B
    )
    INSERT INTO #Ok (ItemCode)
    SELECT ItemCode
    FROM Final
    GROUP BY ItemCode
    HAVING MAX(CASE WHEN TotalQty < ReqQty THEN 1 ELSE 0 END) = 0;   -- = 'OK'
    /* ------------------------------------------------------------------- */

    DECLARE @OkCount INT = (SELECT COUNT(*) FROM #Ok);

    /* ---------- Preview: show what WOULD change, update nothing ---------- */
    IF @PreviewOnly = 1
    BEGIN
        SELECT  O.ItemCode                AS [Item Code],
                O.ItemName                AS [Item Name],
                'OK'                      AS [Item Status],
                O.U_SFAItemActiveStatus   AS [Current U_SFAItemActiveStatus],
                O.U_SFATriggerStatus      AS [Current U_SFATriggerStatus],
                CASE WHEN O.U_SFAItemActiveStatus COLLATE Latin1_General_BIN2 = N'No'
                     THEN 'NO CHANGE'
                     ELSE 'WILL UPDATE TO No / N'
                END                       AS [Action]
        FROM #Ok AS N
        INNER JOIN [BBLive].[dbo].[OITM] AS O ON O.ItemCode = N.ItemCode
        ORDER BY O.ItemCode;

        SELECT  @OkCount AS OkItems,
                SUM(CASE WHEN O.U_SFAItemActiveStatus COLLATE Latin1_General_BIN2 = N'No'
                         THEN 0 ELSE 1 END) AS WillBeUpdated
        FROM #Ok AS N
        INNER JOIN [BBLive].[dbo].[OITM] AS O ON O.ItemCode = N.ItemCode;

        RETURN;
    END

    /* ---------- Update: only OK items that are not already 'No' ---------- */
    DECLARE @Updated INT = 0;

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE O
           SET O.U_SFAItemActiveStatus = N'No',
               O.U_SFATriggerStatus    = N'N'
        OUTPUT deleted.ItemCode,
               deleted.U_SFAItemActiveStatus,
               inserted.U_SFAItemActiveStatus,
               deleted.U_SFATriggerStatus,
               inserted.U_SFATriggerStatus
          INTO dbo.Z_SFA_ItemOkStatusLog (ItemCode, OldValue, NewValue, OldTrigger, NewTrigger)
        FROM [BBLive].[dbo].[OITM] AS O
        INNER JOIN #Ok AS N ON O.ItemCode = N.ItemCode
        WHERE O.U_SFAItemActiveStatus IS NULL                                   -- NULL
           OR O.U_SFAItemActiveStatus COLLATE Latin1_General_BIN2 <> N'No';      -- 'Yes' / other

        SET @Updated = @@ROWCOUNT;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;                                   -- fail the Agent job visibly
    END CATCH;

    SELECT  @OkCount               AS OkItems,
            @Updated               AS UpdatedToNo,
            @OkCount - @Updated    AS AlreadyNo_NoChange;
END
GO


/* =============================================================================
   PART 3 - Manual verification (run these by hand before enabling the job)
   ============================================================================= */
-- 3a. Preview: must match the original OK query (distinct Item Codes). No update.
-- EXEC [BBLive].dbo.usp_SFA_SetOkItemsActiveStatus @PreviewOnly = 1;

-- 3b. Real run.
-- EXEC [BBLive].dbo.usp_SFA_SetOkItemsActiveStatus @PreviewOnly = 0;

-- 3c. Run again: UpdatedToNo should now be 0 (idempotent).
-- EXEC [BBLive].dbo.usp_SFA_SetOkItemsActiveStatus @PreviewOnly = 0;

-- 3d. Audit what was changed.
-- SELECT TOP (500) * FROM [BBLive].dbo.Z_SFA_ItemOkStatusLog ORDER BY LogId DESC;

-- 3e. Items waiting for the Node Product API Sync scheduler to push them.
-- SELECT ItemCode, ItemName, U_SFAItemActiveStatus, U_SFATriggerStatus
-- FROM [BBLive].dbo.OITM
-- WHERE U_SFAItemActiveStatus = 'No' AND U_SFATriggerStatus = 'N';


/* =============================================================================
   PART 4 - SQL Server Agent job: every 3 hours (00:00, 03:00, ... 21:00)
   Re-runnable: drops and recreates the job + its schedule.
   The flagged items are pushed to Salesforce by the Node "Product API Sync"
   scheduler (daily 00:30 IST) or manually via POST /api/sync/productTrigger.
   ============================================================================= */
USE [msdb];
GO

DECLARE @JobName  SYSNAME = N'SFA - Set OK Items Active Status';
DECLARE @SchedName SYSNAME = N'SFA OK Items - Every 3 Hours';

IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = @JobName)
    EXEC msdb.dbo.sp_delete_job @job_name = @JobName, @delete_unused_schedule = 1;

EXEC msdb.dbo.sp_add_job
     @job_name         = @JobName,
     @enabled          = 1,
     @description      = N'Sets OITM.U_SFAItemActiveStatus = ''No'' and U_SFATriggerStatus = ''N'' for OK items (Stock + Open PO + Open JO >= required min qty). Skips items already ''No''.',
     @owner_login_name = N'sa';          -- any sysadmin login

EXEC msdb.dbo.sp_add_jobstep
     @job_name          = @JobName,
     @step_name         = N'Update OK items',
     @subsystem         = N'TSQL',
     @database_name     = N'BBLive',
     @command           = N'EXEC dbo.usp_SFA_SetOkItemsActiveStatus @PreviewOnly = 0;',
     @retry_attempts    = 2,
     @retry_interval    = 5,             -- minutes
     @on_success_action = 1,             -- quit with success
     @on_fail_action    = 2;             -- quit with failure

EXEC msdb.dbo.sp_add_schedule
     @schedule_name        = @SchedName,
     @enabled              = 1,
     @freq_type            = 4,          -- daily
     @freq_interval        = 1,          -- every day
     @freq_subday_type     = 8,          -- unit = hours
     @freq_subday_interval = 3,          -- every 3 hours
     @active_start_time    = 000000,     -- starting 00:00:00
     @active_end_time      = 235959;

EXEC msdb.dbo.sp_attach_schedule
     @job_name      = @JobName,
     @schedule_name = @SchedName;

EXEC msdb.dbo.sp_add_jobserver
     @job_name    = @JobName,
     @server_name = N'(local)';
GO

-- Optional: run the job immediately once to test
-- EXEC msdb.dbo.sp_start_job @job_name = N'SFA - Set OK Items Active Status';

-- Job history
-- SELECT j.name, h.run_date, h.run_time, h.run_status, h.message
-- FROM msdb.dbo.sysjobhistory h
-- JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id
-- WHERE j.name = N'SFA - Set OK Items Active Status'
-- ORDER BY h.instance_id DESC;

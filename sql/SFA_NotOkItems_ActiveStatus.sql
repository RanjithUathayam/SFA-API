/* =============================================================================
   SFA - Set OITM.U_SFAItemActiveStatus = 'Yes' for NOT OK items
   -----------------------------------------------------------------------------
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

IF OBJECT_ID(N'dbo.Z_SFA_ItemActiveStatusLog', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.Z_SFA_ItemActiveStatusLog
    (
        LogId     INT IDENTITY(1,1) NOT NULL
                  CONSTRAINT PK_Z_SFA_ItemActiveStatusLog PRIMARY KEY,
        RunAt     DATETIME2(0)  NOT NULL
                  CONSTRAINT DF_Z_SFA_ItemActiveStatusLog_RunAt DEFAULT SYSDATETIME(),
        ItemCode  NVARCHAR(50)  NOT NULL,
        OldValue  NVARCHAR(254) NULL,
        NewValue  NVARCHAR(254) NULL
    );
END
GO


/* =============================================================================
   PART 2 - Stored procedure
     @PreviewOnly = 1 : list NOT OK items with current value + planned action,
                        NO update.
     @PreviewOnly = 0 : update only NOT OK items whose value is not already
                        exactly 'Yes' (covers 'No', NULL, '', any other value).
   ============================================================================= */
USE [BBLive];
GO

CREATE OR ALTER PROCEDURE dbo.usp_SFA_SetNotOkItemsActiveStatus
    @PreviewOnly BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    /* COLLATE DATABASE_DEFAULT avoids tempdb vs BBLive collation conflicts */
    CREATE TABLE #NotOk
    (
        ItemCode NVARCHAR(50) COLLATE DATABASE_DEFAULT NOT NULL PRIMARY KEY
    );

    /* ---- Existing NOT OK logic - UNCHANGED (only ORDER BY dropped) ---- */
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
    FinalResult AS (
        SELECT R.ItemCode,
               CASE WHEN ISNULL(S.OnHand, 0) <= 0
                     AND ISNULL(P.PO_OpenQty, 0) <= 0
                     AND ISNULL(J.JO_OpenQty, 0) <= 0
                    THEN 1 ELSE 0 END AS IsZero
        FROM Result AS R
        INNER JOIN [BBLive].[dbo].[OITM] AS S ON R.ResultCode = S.ItemCode
        LEFT JOIN PO AS P ON R.ResultCode = P.ItemCode
        LEFT JOIN JO AS J ON R.ResultCode = J.U_ItemCode
        WHERE ISNULL(S.ItemName, '') NOT LIKE '%ACCES%'
          AND ISNULL(S.ItemName, '') NOT LIKE '%SAMPLE PAD%'
    )
    INSERT INTO #NotOk (ItemCode)
    SELECT ItemCode
    FROM FinalResult
    GROUP BY ItemCode
    HAVING MAX(IsZero) = 1;          -- = 'NOT OK'
    /* ------------------------------------------------------------------- */

    DECLARE @NotOkCount INT = (SELECT COUNT(*) FROM #NotOk);

    /* ---------- Preview: show what WOULD change, update nothing ---------- */
    IF @PreviewOnly = 1
    BEGIN
        SELECT  O.ItemCode                AS [Item Code],
                O.ItemName                AS [Item Name],
                'NOT OK'                  AS [Item Status],
                O.U_SFAItemActiveStatus   AS [Current U_SFAItemActiveStatus],
                CASE WHEN O.U_SFAItemActiveStatus COLLATE Latin1_General_BIN2 = N'Yes'
                     THEN 'NO CHANGE'
                     ELSE 'WILL UPDATE TO Yes'
                END                       AS [Action]
        FROM #NotOk AS N
        INNER JOIN [BBLive].[dbo].[OITM] AS O ON O.ItemCode = N.ItemCode
        ORDER BY O.ItemCode;

        SELECT  @NotOkCount AS NotOkItems,
                SUM(CASE WHEN O.U_SFAItemActiveStatus COLLATE Latin1_General_BIN2 = N'Yes'
                         THEN 0 ELSE 1 END) AS WillBeUpdated
        FROM #NotOk AS N
        INNER JOIN [BBLive].[dbo].[OITM] AS O ON O.ItemCode = N.ItemCode;

        RETURN;
    END

    /* ---------- Update: only NOT OK items that are not already 'Yes' ---------- */
    DECLARE @Updated INT = 0;

    BEGIN TRY
        BEGIN TRANSACTION;

        UPDATE O
           SET O.U_SFAItemActiveStatus = N'Yes'
        OUTPUT deleted.ItemCode,
               deleted.U_SFAItemActiveStatus,
               inserted.U_SFAItemActiveStatus
          INTO dbo.Z_SFA_ItemActiveStatusLog (ItemCode, OldValue, NewValue)
        FROM [BBLive].[dbo].[OITM] AS O
        INNER JOIN #NotOk AS N ON O.ItemCode = N.ItemCode
        WHERE O.U_SFAItemActiveStatus IS NULL                                   -- NULL
           OR O.U_SFAItemActiveStatus COLLATE Latin1_General_BIN2 <> N'Yes';     -- 'No' / other

        SET @Updated = @@ROWCOUNT;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
        THROW;                                   -- fail the Agent job visibly
    END CATCH;

    SELECT  @NotOkCount               AS NotOkItems,
            @Updated                  AS UpdatedToYes,
            @NotOkCount - @Updated    AS AlreadyYes_NoChange;
END
GO


/* =============================================================================
   PART 3 - Manual verification (run these by hand before enabling the job)
   ============================================================================= */
-- 3a. Preview: must match the original NOT OK query row-for-row. No update.
-- EXEC [BBLive].dbo.usp_SFA_SetNotOkItemsActiveStatus @PreviewOnly = 1;

-- 3b. Real run.
-- EXEC [BBLive].dbo.usp_SFA_SetNotOkItemsActiveStatus @PreviewOnly = 0;

-- 3c. Run again: UpdatedToYes should now be 0 (idempotent).
-- EXEC [BBLive].dbo.usp_SFA_SetNotOkItemsActiveStatus @PreviewOnly = 0;

-- 3d. Audit what was changed.
-- SELECT TOP (500) * FROM [BBLive].dbo.Z_SFA_ItemActiveStatusLog ORDER BY LogId DESC;


/* =============================================================================
   PART 4 - SQL Server Agent job: every 3 hours (00:00, 03:00, ... 21:00)
   Re-runnable: drops and recreates the job + its schedule.
   ============================================================================= */
USE [msdb];
GO

DECLARE @JobName  SYSNAME = N'SFA - Set NOT OK Items Active Status';
DECLARE @SchedName SYSNAME = N'SFA NOT OK Items - Every 3 Hours';

IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = @JobName)
    EXEC msdb.dbo.sp_delete_job @job_name = @JobName, @delete_unused_schedule = 1;

EXEC msdb.dbo.sp_add_job
     @job_name         = @JobName,
     @enabled          = 1,
     @description      = N'Sets OITM.U_SFAItemActiveStatus = ''Yes'' for NOT OK items (no stock, no open PO, no open JO). Skips items already ''Yes''.',
     @owner_login_name = N'sa';          -- any sysadmin login

EXEC msdb.dbo.sp_add_jobstep
     @job_name          = @JobName,
     @step_name         = N'Update NOT OK items',
     @subsystem         = N'TSQL',
     @database_name     = N'BBLive',
     @command           = N'EXEC dbo.usp_SFA_SetNotOkItemsActiveStatus @PreviewOnly = 0;',
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
-- EXEC msdb.dbo.sp_start_job @job_name = N'SFA - Set NOT OK Items Active Status';

-- Job history
-- SELECT j.name, h.run_date, h.run_time, h.run_status, h.message
-- FROM msdb.dbo.sysjobhistory h
-- JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id
-- WHERE j.name = N'SFA - Set NOT OK Items Active Status'
-- ORDER BY h.instance_id DESC;

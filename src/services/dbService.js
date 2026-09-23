const sql = require('mssql');
const config = require('../config/dbConfig');

let pool;

async function getPool() {
    if (!pool) {
        pool = await sql.connect(config);
        console.log('SQL Pool Created');
    }
    return pool;
}

async function getProductData(lastSyncDate, offset = 0, limit = 500) {
    const pool = await getPool();

    const query = `SELECT DISTINCT
            t0.ItemCode AS ProductCode,
            case when t0.U_SubGrp1='UATHAYAM DHOTIE' THEN t3.U_CatalgCode ELSE t0.ItemName END AS ProductName,
            CASE WHEN t0.U_SFAItemActiveStatus = 'Yes' THEN 0 ELSE 1 END AS ProductIsActive,
            t0.U_SubGrp7 AS ProductGroupCode,
            t0.U_SubGrp7 AS ShortDesc,
            t0.ItemName AS DetailedDesc,
            t0.U_SubGrp3 AS CategoryName,
            t0.U_SubGrp4 AS StyleCode,
            RTRIM(t0.U_SubGrp5) AS SizeCode,
            CASE
                WHEN t0.U_SubGrp1 LIKE '%ARISER%'   THEN 'ARISER'
                WHEN t0.U_SubGrp1 LIKE '%UATHAYAM%' THEN 'UATHAYAM'
            END AS DivisionCode,
            t0.SalPackMsr AS UOM,
            t0.U_SubGrp3 AS AttributeSetName,
            RTRIM(t0.U_SubGrp5) AS SizeGroup,
            t0.U_HSNCODE AS HSNCode,
            t0.U_SubGrp1 AS Brand,
            t0.SalPackUn AS SalPackUn,
            RTRIM(t0.U_SubGrp6) AS ColorCode,
            ISNULL(t0.U_SubGrp11, T0.U_SUBGRP6) AS ColorName,
            ISNULL(t0.U_SubGrp17, T0.U_SubGrp6) AS Color,
            ISNULL(t0.U_SubGrp13, T0.U_SubGrp6) AS Shade,
            t0.MinLevel AS Min_Qty,
            t0.MaxLevel AS Max_Qty,
            CASE WHEN t0.U_SubGrp13='Core item' THEN 1 ELSE 0 END AS IsCoreColor,
            t0.U_taxrate AS TaxBelow2500,
            t0.U_taxrate1000 AS TaxAbove2500,
            t0.U_SubGrp1 AS SubBrandCode,nattu.SerialNo as ColorSort
        FROM [BBLive].[dbo].oitm t0
        JOIN [BBLive].[dbo].oitb t1 ON t0.ItmsGrpCod = t1.ItmsGrpCod
        LEFT JOIN
        (
            select t0.U_SubGroup3,t1.U_SubGroup1,t1.U_SubGroup7,t1.U_SubGroup4,T3.U_Size,T3.U_SelPrice,T3.U_MRP,T2.U_Code from [BBLive].[dbo]."@INS_OPLSN" as t0 WITH(NOLOCK)
            INNER JOIN [BBLive].[dbo]."@INS_PLSN1" AS T1  WITH(NOLOCK) ON t0.DocEntry=T1.DocEntry
            INNER JOIN [BBLive].[dbo]."@INS_PLSN3" AS T3  WITH(NOLOCK) ON t0.DocEntry=T3.DocEntry AND T1.LineId=T3.U_UniqID
            INNER JOIN [BBLive].[dbo]."@INS_PLSN2" AS T2  WITH(NOLOCK) ON t0.DocEntry=T2.DocEntry AND T2.U_Selected='Y'
            WHERE GETDATE() BETWEEN t0.U_ValidFrom AND t0.U_ValidTo
        )F ON CONCAT(F.U_SubGroup7,F.U_SubGroup4,'',F.U_SubGroup1,'',F.U_Size)=concat(T0.U_SubGrp7,T0.U_SUBGRP4,'',T0.U_SubGrp1,'',T0.U_SUBGRP5)
        LEFT JOIN [BBLive].[dbo]."@INS_OPLM" T2 ON T2.U_ItemCode=T0.ItemCode
		inner join [BBLive].[dbo].mohan as nattu on nattu.U_SubGrp6=t0.U_SubGrp6 and nattu.u_subgrp1=t0.U_SubGrp1 and nattu.U_SubGrp7=t0.U_SubGrp7
        OUTER APPLY (
            SELECT TOP 1 T3x.U_CatalgCode
            FROM [BBLive].[dbo]."@INS_PLM1" T3x
            WHERE T3x.DocEntry = T2.DocEntry AND T3x.U_Lock = 'N'
            ORDER BY T3x.LineId DESC   -- confirm this is the right tie-breaker for "current" catalog code
        ) T3
        WHERE
            (
                EXISTS (
                    SELECT 1
                    FROM [BBLive].[dbo].OITM AS A
                    INNER JOIN
                    (
                        select t0b.U_SubGroup3, t1b.U_SubGroup1, t1b.U_SubGroup7, t1b.U_SubGroup4, T3b.U_Size
                        from [BBLive].[dbo]."@INS_OPLSN" as t0b WITH(NOLOCK)
                        INNER JOIN [BBLive].[dbo]."@INS_PLSN1" AS T1b WITH(NOLOCK) ON t0b.DocEntry=T1b.DocEntry
                        INNER JOIN [BBLive].[dbo]."@INS_PLSN3" AS T3b WITH(NOLOCK) ON t0b.DocEntry=T3b.DocEntry AND T1b.LineId=T3b.U_UniqID
                        INNER JOIN [BBLive].[dbo]."@INS_PLSN2" AS T2b WITH(NOLOCK) ON t0b.DocEntry=T2b.DocEntry AND T2b.U_Selected='Y'
                        WHERE GETDATE() BETWEEN t0b.U_ValidFrom AND t0b.U_ValidTo
                        AND t1b.U_SubGroup7 = t0.U_SubGrp7
                        GROUP BY t0b.U_SubGroup3, t1b.U_SubGroup1, t1b.U_SubGroup7, t1b.U_SubGroup4, T3b.U_Size
                    ) AS B ON CONCAT(B.U_SubGroup7,B.U_SubGroup4,'',B.U_SubGroup1,'',B.U_Size)
                            = CONCAT(A.U_SubGrp7,A.U_SUBGRP4,'',A.U_SubGrp1,'',A.U_SUBGRP5)
                    WHERE A.ItemCode = t0.ItemCode
                )
                OR EXISTS (
                    SELECT 1
                    FROM [BBLive].[dbo]."@INS_OPLM" plm
                    INNER JOIN [BBLive].[dbo]."@INS_PLM2" plm2 ON plm2.DocEntry = plm.DocEntry
                    WHERE plm.U_ItemCode = t0.ItemCode
                    AND plm2.U_SelPrice > 0
                )
            )
        AND t0.validFor = 'Y'
        AND t0.U_SubGrp1 NOT IN (
            'ACCESSORIES','ADVERTISEMENT','ALL','SAMPLE','PRINTING & STATIONERY',
            'IMPERIAL COMPUTERS','PACKING MATERIAL','REPAIRS & MAINTENANCE',
            'SALES PROMOTION EXPENSES','EVERYDAY DHOTIE','ALLDAYS DHOTIE',
            'ADD DHOTIE','ADD SHIRT','EVERYDAY SHIRTING','EVERYDAY RDY'
        )
        -- AND t0.U_SubGrp7 = 'VAIBHAV KIDS PNCH 3IN1 SET'
        ORDER BY t0.ItemCode
        OFFSET @offset ROWS
        FETCH NEXT @limit ROWS ONLY`

    const result = await pool.request()
        .input('lastSyncDate', sql.DateTime, lastSyncDate)
        .input('offset', sql.Int, offset)
        .input('limit', sql.Int, limit)
        .query(query);

    return result.recordset;
}

async function getPriceListData() {
    try {
        const pool = await getPool();

        const query = `
        IF OBJECT_ID('tempdb..#finalout') IS NOT NULL DROP TABLE #finalout;

        WITH itempriced AS (
            SELECT T1.u_itemcode, T0.docentry, T2.u_brand, T0.u_state,
                T0.u_selprice, T0.u_mrp, T2.u_lock, T0.lineid, T2.u_catalgcode
            FROM   [BBLive].[dbo].[@ins_plm2]  T0 WITH (NOLOCK)
                INNER JOIN [BBLive].[dbo].[@ins_oplm] T1 WITH (NOLOCK) ON T0.docentry = T1.docentry
                INNER JOIN [BBLive].[dbo].[@ins_plm1] T2 WITH (NOLOCK) ON T0.docentry = T2.docentry
                                                                        AND T2.lineid = T0.u_rowid
            WHERE  T2.u_lock = 'N'
                AND T0.u_mrp > 0
                AND T0.u_state IN ('TN','KA','KL','AP')          -- push filter down
        ),
        sizepriced AS (
            SELECT T1b.u_subgroup1, T1b.u_subgroup7, T1b.u_subgroup4, T3b.u_size,
                T0b.docentry, T1b.U_SubGroup1 AS U_Brand,
                CAST(T2b.u_code AS VARCHAR(50)) AS U_State,
                T3b.u_selprice, T3b.u_mrp, 'N' AS U_Lock, T1b.lineid,
                CAST(NULL AS VARCHAR(50)) AS U_CatalgCode
            FROM   [BBLive].[dbo].[@ins_oplsn] T0b WITH (NOLOCK)
                INNER JOIN [BBLive].[dbo].[@ins_plsn1] T1b WITH (NOLOCK) ON T0b.docentry = T1b.docentry
                INNER JOIN [BBLive].[dbo].[@ins_plsn3] T3b WITH (NOLOCK) ON T0b.docentry = T3b.docentry
                                                                            AND T1b.lineid = T3b.u_uniqid
                INNER JOIN [BBLive].[dbo].[@ins_plsn2] T2b WITH (NOLOCK) ON T0b.docentry = T2b.docentry
                                                                            AND T2b.u_selected = 'Y'
                                                                            AND T3b.U_Lock <> 'Y'
            WHERE  GETDATE() BETWEEN T0b.u_validfrom AND T0b.u_validto
                AND T1b.U_SubGroup1 NOT IN ('UATHAYAM MENS SET','UATHAYAM KIDS SET','ARISER HOS','UATHAYAM HOS','ARISER KNITS')
                AND T3b.u_mrp > 0
                AND T0b.U_DocDate > '20260101'
                AND T2b.u_code IN ('TN','KA','KL','AP')          -- push filter down
        ),

        combined AS (
            SELECT t0.itemcode AS ProductCode, B.docentry AS PriceListID, B.u_state AS SubBrandCode,
                t0.itemname AS BPProductName,                    -- dead CASE removed (always excludes DHOTIE here)
                B.u_catalgcode AS CatalogCode, B.u_state AS PriceListCode,
                CAST(NULL AS DATE) AS EffectiveFrom, CAST(NULL AS DATE) AS EffectiveTo,
                CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END AS PriceListIsActive,
                'Dealer' AS BPCategory, B.u_selprice AS Price, B.u_mrp AS MRP, B.lineid AS PriceID,
                CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END AS PriceIsActive,
                t0.u_subgrp1 AS SubGrp1, 'PriceList (@INS_OPLSN)' AS SourceTable, 1 AS SourcePriority
            FROM   [BBLive].[dbo].oitm t0 WITH (NOLOCK)
                INNER JOIN sizepriced B ON B.u_subgroup7 = t0.u_subgrp7
                                        AND B.u_subgroup4 = t0.u_subgrp4
                                        AND B.u_subgroup1 = t0.u_subgrp1
                                        AND B.u_size      = t0.u_subgrp5
            WHERE  B.u_selprice > 0
                AND t0.u_subgrp1 <> 'UATHAYAM DHOTIE'
                AND t0.validfor = 'Y'
                AND B.u_brand NOT IN ('ACCESSORIES','ADVERTISEMENT','ALL','SAMPLE','PRINTING & STATIONERY',
                                        'IMPERIAL COMPUTERS','PACKING MATERIAL','REPAIRS & MAINTENANCE',
                                        'SALES PROMOTION EXPENSES','EVERYDAY DHOTIE','ALLDAYS DHOTIE','ADD DHOTIE',
                                        'EVERYDAY SHIRTING','EVERYDAY RDY','ADD SHIRT') 
            UNION ALL
            SELECT t0.itemcode, B.docentry, B.u_state,
                CASE WHEN t0.u_subgrp1 = 'UATHAYAM DHOTIE' THEN B.u_catalgcode ELSE t0.itemname END,
                B.u_catalgcode, B.u_state,
                CAST(NULL AS DATE), CAST(NULL AS DATE),
                CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END,
                'Dealer', B.u_selprice, B.u_mrp, B.lineid,
                CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END,
                t0.u_subgrp1, 'PriceList Master (@INS_OPLM)', 2
            FROM   [BBLive].[dbo].oitm t0 WITH (NOLOCK)
                INNER JOIN itempriced B ON B.u_itemcode = t0.itemcode
            WHERE  B.u_selprice > 0
                AND t0.validfor = 'Y'
                AND B.u_brand NOT IN ('ACCESSORIES','ADVERTISEMENT','ALL','SAMPLE','PRINTING & STATIONERY',
                                        'IMPERIAL COMPUTERS','PACKING MATERIAL','REPAIRS & MAINTENANCE',
                                        'SALES PROMOTION EXPENSES','EVERYDAY DHOTIE','ALLDAYS DHOTIE','ADD DHOTIE',
                                        'EVERYDAY SHIRTING','EVERYDAY RDY','ADD SHIRT')   
        ),
        ranked AS (
            SELECT *,
                ROW_NUMBER() OVER (PARTITION BY ProductCode, SubBrandCode, BPProductName
                                    ORDER BY SourcePriority, PriceID) AS rn
            FROM   combined
        )
        SELECT ProductCode, PriceListID, SubBrandCode, BPProductName, CatalogCode, PriceListCode,
            EffectiveFrom, EffectiveTo, PriceListIsActive, BPCategory, Price, MRP, PriceID, PriceIsActive
        INTO   #finalout
        FROM   ranked
        WHERE  rn = 1;

        CREATE CLUSTERED INDEX ix_finalout_state ON #finalout (PriceListCode);

        /* ---------------------------------------------------------------
        Now build the output from the materialized #finalout ONCE.
        ------------------------------------------------------------- */
        SELECT ProductCode, PriceListID, SubBrandCode, BPProductName, CatalogCode, PriceListCode,
            EffectiveFrom, EffectiveTo, PriceListIsActive, BPCategory, Price, MRP, PriceID, PriceIsActive
        FROM   #finalout
        WHERE  PriceListCode <> 'TS'
        UNION ALL
        SELECT ProductCode, PriceListID, 'TS', BPProductName, CatalogCode, 'TS',
            EffectiveFrom, EffectiveTo, PriceListIsActive, BPCategory, Price, MRP, PriceID, PriceIsActive
        FROM   #finalout
        WHERE  SubBrandCode = 'AP';

        DROP TABLE #finalout;`

        // const query = `
        //         WITH itempriced
        //             AS (SELECT T1.u_itemcode,
        //                         T0.docentry,
        //                         T2.u_brand,
        //                         T0.u_state,
        //                         T0.u_selprice,
        //                         T0.u_mrp,
        //                         T2.u_lock,
        //                         T0.lineid,
        //                         T2.u_catalgcode
        //                 FROM   [BBLive].[dbo].[@ins_plm2] T0
        //                         INNER JOIN [BBLive].[dbo].[@ins_oplm] T1
        //                                 ON T0.docentry = T1.docentry
        //                         INNER JOIN [BBLive].[dbo].[@ins_plm1] T2
        //                                 ON T0.docentry = T2.docentry
        //                                 AND T2.lineid = T0.u_rowid
        //                 WHERE  T2.u_lock = 'N'
        //                         AND T0.u_mrp > 0),
        //             sizepriced
        //             AS (SELECT T1b.u_subgroup1,
        //                         T1b.u_subgroup7,
        //                         T1b.u_subgroup4,
        //                         T3b.u_size,
        //                         T0b.docentry,
        //                         T1b.U_SubGroup1  AS U_Brand,
        //                         Cast(T2b.u_code AS VARCHAR(50)) AS U_State,
        //                         T3b.u_selprice,
        //                         T3b.u_mrp,
        //                         'N'                       AS U_Lock,
        //                         T1b.lineid,
        //                         Cast(NULL AS VARCHAR(50)) AS U_CatalgCode
        //                 FROM   [BBLive].[dbo].[@ins_oplsn] T0b WITH (nolock)
        //                         INNER JOIN [BBLive].[dbo].[@ins_plsn1] T1b WITH (nolock)
        //                                 ON T0b.docentry = T1b.docentry
        //                         INNER JOIN [BBLive].[dbo].[@ins_plsn3] T3b WITH (nolock)
        //                                 ON T0b.docentry = T3b.docentry
        //                                 AND T1b.lineid = T3b.u_uniqid
        //                         INNER JOIN [BBLive].[dbo].[@ins_plsn2] T2b WITH (nolock)
        //                                 ON T0b.docentry = T2b.docentry
        //                                 AND T2b.u_selected = 'Y'
        //                 WHERE  Getdate() BETWEEN T0b.u_validfrom AND T0b.u_validto
        //                        -- AND T1b.u_subgroup7 in ('MAJESTIC')
        //                         AND T3b.u_mrp > 0
		// 			 ),
        //             combined
        //             AS (
        //                 -- Source 1: SizePriced from [@INS_OPLSN] (NEW - preferred) -> priority 1
        //                 SELECT t0.itemcode  AS ProductCode,
        //                     B.docentry   AS PriceListID,
        //                     B.u_state    AS SubBrandCode,
        //                     CASE
        //                         WHEN t0.u_subgrp1 = 'UATHAYAM DHOTIE' THEN B.u_catalgcode
        //                         ELSE t0.itemname
        //                     END          AS BPProductName,
        //                     B.u_state    AS PriceListCode,
        //                     NULL         AS EffectiveFrom,
        //                     NULL         AS EffectiveTo,
        //                     CASE
        //                         WHEN B.u_lock = 'Y' THEN 0
        //                         ELSE 1
        //                     END          AS PriceListIsActive,
        //                     'Dealer'     AS BPCategory,
        //                     B.u_selprice AS Price,
        //                     B.u_mrp      AS MRP,
        //                     B.lineid     AS PriceID,
        //                     CASE
        //                         WHEN B.u_lock = 'Y' THEN 0
        //                         ELSE 1
        //                     END          AS PriceIsActive,
        //                     1            AS SourcePriority
        //                 FROM   [BBLive].[dbo].oitm t0
        //                     INNER JOIN sizepriced B
        //                             ON B.u_subgroup7 = t0.u_subgrp7
        //                                 AND B.u_subgroup4 = t0.u_subgrp4
        //                                 AND B.u_subgroup1 = t0.u_subgrp1
        //                                 AND B.u_size = t0.u_subgrp5
        //                 WHERE  B.u_selprice > 0
        //                     AND B.u_brand NOT IN ( 'ACCESSORIES', 'ADVERTISEMENT', 'ALL',
        //                                             'SAMPLE'
        //                                             ,
        //                                             'PRINTING & STATIONERY',
        //                                             'IMPERIAL COMPUTERS',
        //                                                 'PACKING MATERIAL',
        //                                             'REPAIRS & MAINTENANCE',
        //                                             'SALES PROMOTION EXPENSES',
        //                                             'EVERYDAY DHOTIE',
        //                                                 'ALLDAYS DHOTIE', 'ADD DHOTIE',
        //                                             'ADD SHIRT', 'EVERYDAY SHIRTING',
        //                                             'EVERYDAY RDY' )
		// 					--AND t0.u_subgrp7 in ('MAJESTIC')
        //                     AND t0.validfor = 'Y'
        //                 UNION ALL
        //                 -- Source 2: ItemPriced from [@INS_OPLM] (fallback) -> priority 2
        //                 SELECT t0.itemcode  AS ProductCode,
        //                         B.docentry   AS PriceListID,
        //                         B.u_state    AS SubBrandCode,
        //                         CASE
        //                         WHEN t0.u_subgrp1 = 'UATHAYAM DHOTIE' THEN B.u_catalgcode
        //                         ELSE t0.itemname
        //                         END          AS BPProductName,
        //                         B.u_state    AS PriceListCode,
        //                         NULL         AS EffectiveFrom,
        //                         NULL         AS EffectiveTo,
        //                         CASE
        //                         WHEN B.u_lock = 'Y' THEN 0
        //                         ELSE 1
        //                         END          AS PriceListIsActive,
        //                         'Dealer'     AS BPCategory,
        //                         B.u_selprice AS Price,
        //                         B.u_mrp      AS MRP,
        //                         B.lineid     AS PriceID,
        //                         CASE
        //                         WHEN B.u_lock = 'Y' THEN 0
        //                         ELSE 1
        //                         END          AS PriceIsActive,
        //                         2            AS SourcePriority
        //                 FROM   [BBLive].[dbo].oitm t0
        //                         INNER JOIN itempriced B
        //                                 ON B.u_itemcode = t0.itemcode
        //                 WHERE  B.u_selprice > 0
        //                         AND B.u_brand NOT IN ( 'ACCESSORIES', 'ADVERTISEMENT', 'ALL',
        //                                             'SAMPLE',
        //                                             'PRINTING & STATIONERY',
        //                                             'IMPERIAL COMPUTERS',
        //                                                 'PACKING MATERIAL',
        //                                             'REPAIRS & MAINTENANCE',
        //                                             'SALES PROMOTION EXPENSES',
        //                                             'EVERYDAY DHOTIE',
        //                                                 'ALLDAYS DHOTIE', 'ADD DHOTIE',
        //                                             'ADD SHIRT', 'EVERYDAY SHIRTING',
        //                                             'EVERYDAY RDY'
        //                                             )
        //                         AND t0.validfor = 'Y'
		// 						--AND t0.u_subgrp7 in ('MAJESTIC')
        //                          ),
        //             ranked
        //             AS (SELECT *,
        //                         Row_number()
        //                         OVER (
        //                             partition BY ProductCode, SubBrandCode
        //                             ORDER BY sourcepriority ) AS rn
        //                 FROM   combined)
        //         SELECT ProductCode,
        //             PriceListID,
        //             SubBrandCode,
        //             BPProductName,
        //             PriceListCode,
        //             EffectiveFrom,
        //             EffectiveTo,
        //             PriceListIsActive,
        //             BPCategory,
        //             Price,
        //             MRP,
        //             PriceID,
        //             PriceIsActive
        //         FROM   ranked
        //     WHERE  rn = 1
        // `;

        const { recordset } = await pool.request().query(query);
        return recordset;

    } catch (err) {
        console.error('❌ SQL Error (PriceList):', err);
        throw err;
    }
}

async function getImageData() {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT
                t0.itemcode  AS skuCode,
                T0.U_SubGrp6 AS ColorCode,
                ''           AS fileName,
                ''           AS Description,
                ''           AS base64Data
            FROM [BBLive].[dbo].oitm AS t0
            WHERE t0.U_SubGrp7 IN ('JETA')
        `);
        return result.recordset;
    } catch (err) {
        console.error('SQL Error (Images):', err);
        throw err;
    }
}

async function getSchemeData() {
    try {
        const pool = await getPool()    
        const query = `
            WITH 
                HeaderLine AS (
                    SELECT 
                    T0.DocEntry, 
                    T0.[Object], 
                    T0.Remark, 
                    T0.U_FrmDt, 
                    T0.U_ToDt, 
                    T1.U_Discunt, 
                    T1.U_bran, 
                    ROW_NUMBER() OVER (
                        PARTITION BY T0.DocEntry 
                        ORDER BY 
                        (
                            SELECT 
                            NULL
                        )
                    ) AS rn 
                    FROM 
                    [BBLive].[dbo].[@SCHEM] T0 
                    INNER JOIN [BBLive].[dbo].[@SCHEML] T1 ON T0.DocEntry = T1.DocEntry 
                    WHERE 
                    GETDATE() BETWEEN T0.U_FrmDt 
                    AND T0.U_ToDt
                ) 
                SELECT 
                CAST(
                    CONCAT(H.[Object], H.DocEntry) AS NVARCHAR(50)
                ) AS PolicyNumber, 
                1 AS Revision, 
                H.DocEntry AS PolicyID, 
                H.Remark AS PolicyName, 
                CASE WHEN H.U_Discunt = 'Quantity' THEN 'SC' WHEN H.U_Discunt = 'Percentage' THEN 'DIS' END AS SavingType, 
                H.U_Discunt AS DiscountBasis, 
                'PG' AS Applicability, 
                1 AS IsCustomerDefined, 
                1 AS IsActive, 
                CASE WHEN H.U_bran = 'UATHAYAM DHOTIE' THEN 'UATHAYAM' WHEN H.U_bran = 'UATHAYAM SHIRTING' THEN 'UATHAYAM' WHEN H.U_bran = 'UATHAYAM RDY' THEN 'UATHAYAM' WHEN H.U_bran = 'UATHAYAM HOS' THEN 'UATHAYAM' WHEN H.U_bran = 'UATHAYAM KIDS SET' THEN 'UATHAYAM' WHEN H.U_bran = 'UATHAYAM MENS SET' THEN 'UATHAYAM' WHEN H.U_bran = 'ARISER SHIRT' THEN 'ARISER' WHEN H.U_bran = 'ARISER MENS TROUSERS' THEN 'ARISER' WHEN H.U_bran = 'ARISER KNITS' THEN 'ARISER' END AS DivisionCode, 
                GETDATE() AS FromDate, 
                '2026-12-31T00:00:00' AS ToDate, 
                0 AS AllowDiscountForAllProducts, 
                NULL AS DiscountPer, 
                (
                    SELECT 
                    'DEALER' AS BPCategory FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_BpCategoryMapping, 
                (
                    SELECT 
                    DISTINCT ST.Name AS StateCode 
                    FROM [BBLive].[dbo].[@SCHEML] L 
					INNER JOIN [BBLive].[dbo].OCST ST ON ST.Code = L.U_Stat
                    WHERE 
                    L.DocEntry = H.DocEntry 
                    AND L.U_Stat IS NOT NULL 
					FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS StateMapping, 
                (
                    SELECT 
                    'DEALER' AS Role FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS RoleMapping, 
                (
                    SELECT 
                    NULL AS BPCode FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_BpExclution, 
                (
                    SELECT 
                    DISTINCT C.CardCode AS BPCode 
                    FROM 
                    [BBLive].[dbo].OCRD C 
                    INNER JOIN [BBLive].[dbo].CRD1 D ON C.CardCode = D.CardCode 
                    AND D.AdresType = 'B' 
                    WHERE 
                    D.State IN (
                        SELECT 
                        DISTINCT L.U_Stat 
                        FROM 
                        [BBLive].[dbo].[@SCHEML] L 
                        WHERE 
                        L.DocEntry = H.DocEntry
                    ) FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_BpInclution, 
                (
					SELECT
						CAST(NULL AS NVARCHAR(50)) AS ProductCode,
						CAST(NULL AS NVARCHAR(50)) AS SizeCode,
						CAST(NULL AS NVARCHAR(50)) AS ColorCode,
						CAST(NULL AS DECIMAL(10,2)) AS MinOrderQty,
						CAST(NULL AS DECIMAL(10,2)) AS FreeQty,
						CAST(NULL AS NVARCHAR(10)) AS Applicability,
						CAST(NULL AS INT) AS AllowMultiplyFreeQty,
						CAST(NULL AS DECIMAL(10,2)) AS MaxAllowedFreeQty,
						CAST(NULL AS INT) AS IsActive,
						CAST(NULL AS INT) AS MappingStatus,
						(
							SELECT
								CAST(NULL AS NVARCHAR(50)) AS ProductCode,
								CAST(NULL AS NVARCHAR(50)) AS SizeCode,
								CAST(NULL AS NVARCHAR(50)) AS ColorCode,
								0 AS IsActive
							FOR JSON PATH, INCLUDE_NULL_VALUES
						) AS SC_ProdAlternate
					FOR JSON PATH, INCLUDE_NULL_VALUES
				) AS SC_ProductMapping, 
                (
					SELECT
						SD.MappingID,
						SD.GroupCode,
						SD.StyleCode,
						SD.MinOrderQty,
						SD.FreeQty,
						SD.Applicability,
						SD.AllowMultiplyFreeQty,
						SD.MaxAllowedFreeQty,
						SD.GroupName,
						SD.IsActive,
						SD.MappingStatus,
						SD.SC_ProdAlternate
					FROM
					(
						SELECT
							CAST(CONCAT(L.DocEntry, L.LineId) AS NVARCHAR(50)) AS MappingID,
							L.U_Qual AS GroupCode,
							I.U_SubGrp4 AS StyleCode,
							CAST(L.U_BillsQty AS DECIMAL(10,2)) AS MinOrderQty,
							CAST(L.U_OffersQty AS DECIMAL(10,2)) AS FreeQty,
							'S' AS Applicability,
							1 AS AllowMultiplyFreeQty,
							9999 AS MaxAllowedFreeQty,
							L.U_Qual AS GroupName,
							1 AS IsActive,
							1 AS MappingStatus,

							(
								SELECT DISTINCT
									ALT.U_SubGrp7 AS GroupName,
									ALT.U_SubGrp7 AS StyleName,
									0 AS IsActive
								FROM [BBLive].[dbo].OITM ALT
								WHERE ALT.U_SubGrp7 = L.U_Qual
									AND ALT.validFor = 'Y'
								FOR JSON PATH, INCLUDE_NULL_VALUES
							) AS SC_ProdAlternate,

							ROW_NUMBER() OVER
							(
								PARTITION BY L.U_Qual, I.U_SubGrp4
								ORDER BY L.LineId
							) AS RN

						FROM [BBLive].[dbo].[@SCHEML] L
						INNER JOIN [BBLive].[dbo].OITM I
							ON I.U_SubGrp7 = L.U_Qual

						WHERE I.validFor = 'Y'
							AND L.DocEntry = H.DocEntry
							AND I.U_SubGrp4 IS NOT NULL
					) SD

					WHERE SD.RN = 1

					FOR JSON PATH, INCLUDE_NULL_VALUES
                ) AS SC_ProdGroupMapping, 
                (
                    SELECT 
                    NULL AS ProductCode, 
                    NULL AS SizeCode, 
                    NULL AS ColorCode, 
                    0 AS IsActive FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_ProdAlternate, 
                (
                    SELECT 
                    NULL AS GroupName, 
                    NULL AS StyleCode, 
                    0 AS IsActive FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_ProdGroupAlternate, 
                (
                    SELECT 
                    NULL AS Brand, 
                    NULL AS DiscountType, 
                    NULL AS DiscountVal, 
                    0 AS IsActive FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_Brand_Discount, 
                (
                    SELECT 
                    NULL AS DivisionCode, 
                    NULL AS GroupCode, 
                    NULL AS GroupName, 
                    NULL AS StyleCode, 
                    NULL AS StyleName, 
                    NULL AS DiscountType, 
                    NULL AS DiscountVal, 
                    0 AS IsActive FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_ProdGroupDirectDiscount, 
                (
                    SELECT 
                    NULL AS ProductCode, 
                    NULL AS SizeCode, 
                    NULL AS ColorCode, 
                    NULL AS DiscountType, 
                    NULL AS DiscountVal, 
                    0 AS IsActive FOR JSON PATH, 
                    INCLUDE_NULL_VALUES
                ) AS SC_ProductDirectDiscount 
                FROM HeaderLine H 
                WHERE H.rn = 1
        `;

        const { recordset } = await pool.request().query(query);
        return recordset;

    } catch (err) {
        console.error('❌ SQL Error (Schemes):', err);
        throw err;
    }
}

// BP MASTER
async function getBPMasterData(cardCodes = null) {
    try {
        const pool = await getPool();
        const req  = pool.request();

        let codeFilter = '';
        if (cardCodes && cardCodes.length > 0) {
            const placeholders = cardCodes.map((c, i) => { req.input(`c${i}`, sql.NVarChar(50), c); return `@c${i}`; }).join(',');
            codeFilter = `AND T0.CardCode IN (${placeholders})`;
        }

       const query = `
            WITH SubBrandMap AS (
                SELECT *
                FROM (VALUES
                    ('ARISER',   'ARISER SHIRT',           'U_Dis7'),
                    ('ARISER',   'ARISER KNITS',             'U_Dis3'),
                    ('ARISER',   'ARISER MENS TROUSERS',   'U_Dis10'),
                    ('UATHAYAM', 'UATHAYAM DHOTIE',        'U_Dis1'),
                    ('UATHAYAM', 'UATHAYAM SHIRTING',      'U_Dis1'),
                    ('UATHAYAM', 'UATHAYAM RDY',           'U_Dis2'),
                    ('UATHAYAM', 'UATHAYAM HOS',           'U_Dis3'),
                    ('UATHAYAM', 'UATHAYAM KIDS SET',      'U_Dis9'),
                    ('UATHAYAM', 'UATHAYAM MENS SET',      'U_Dis11')
                ) AS X(DivisionCode, SubBrandName, DiscountColumn)
            )

            SELECT
                T0.CardCode   AS BPCode,
                T0.CardName   AS BPName,
                T0.Currency   AS DefaultCurrency,
                CASE WHEN T0.validFor = 'Y' THEN 1 ELSE 0 END AS IsActive,
                0 AS AllowCreditLimit,
                T0.CardFName AS DisplayName,
                CASE WHEN T0.GroupCode IN ('100','106') THEN 'Dealer' ELSE '' END AS BPCategory,
                '' AS BPGroupCode,
                T0.U_showcode AS SR_BPCode,

                CASE 
                    WHEN ISNULL(T0.U_Grade, '') IN ('', '-') THEN 'C'
                    ELSE REPLACE(T0.U_Grade, 'Grade', '')
                END AS GradeOfBP,

                '' AS CustomerRemark,
                CAST(0 AS DECIMAL(18,2)) AS Latitude,
                CAST(0 AS DECIMAL(18,2)) AS Longitude,
                T0.U_AreaCode AS AreaCode,

                SB.DivisionCode,
                SB.SubBrandName AS Brand,
                SB.SubBrandName,

                -- 🔹 Dynamic Discount Mapping (NO CASE REPEAT)
                CAST(
                    CASE SB.DiscountColumn
                        WHEN 'U_Dis1'  THEN ISNULL(T0.U_Dis1,0)
                        WHEN 'U_Dis2'  THEN ISNULL(T0.U_Dis2,0)
                        WHEN 'U_Dis3'  THEN ISNULL(T0.U_Dis3,0)
                        WHEN 'U_Dis4'  THEN ISNULL(T0.U_Dis4,0)
                        WHEN 'U_Dis5'  THEN ISNULL(T0.U_Dis5,0)
                        WHEN 'U_Dis6'  THEN ISNULL(T0.U_Dis6,0)
                        WHEN 'U_Dis7'  THEN ISNULL(T0.U_Dis7,0)
                        WHEN 'U_Dis8'  THEN ISNULL(T0.U_Dis8,0)
                        WHEN 'U_Dis9'  THEN ISNULL(T0.U_Dis9,0)
                        WHEN 'U_Dis10' THEN ISNULL(T0.U_Dis10,0)
                        WHEN 'U_Dis11' THEN ISNULL(T0.U_Dis11,0)
                        ELSE 0
                    END
                AS DECIMAL(18,6)) AS DiscountPer,

                ------------------------------------------------------------------
                -- BILL / SHIP
                ------------------------------------------------------------------
                (
                    SELECT
                        CAST(ISNULL(T0.DocEntry,1) AS VARCHAR) + CAST(T1.LineNum AS VARCHAR) AS BillShipID,
                        T1.AdresType AS Type,
                        T0.CardName AS DisplayName,
                        CASE WHEN T1.AdresType = 'B' THEN 'OFFICE' ELSE 'SHIP' END AS LocationName,
                        ISNULL(NULLIF(CAST(T1.Building AS NVARCHAR(MAX)),''), T1.City) AS Line1,
                        ISNULL(NULLIF(CAST(T1.Block AS NVARCHAR(MAX)),''), T1.City) AS Line2,
                        ISNULL(NULLIF(CAST(T1.Street AS NVARCHAR(MAX)),''), T1.City) AS Line3,
                        CASE WHEN T0.ShipToDef = T1.Address THEN 1 ELSE 0 END AS IsDefault,
                        ISNULL(T1.City,'') AS City,
                        ISNULL(T1.County, T1.Country) AS County,
                        ISNULL(T1.State,'') AS State,
                        ISNULL(T1.Country,'') AS Country,
                        ISNULL(T1.ZipCode,'') AS ZipCode,
                        CASE 
                            WHEN LEN(RIGHT(ISNULL(T0.Phone1,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone1,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone1,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Phone2,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone2,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone2,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Cellular,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Cellular,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Cellular,10)

                            ELSE '9999999999'
                        END AS PhoneNumber,

                        CASE 
                            WHEN LEN(RIGHT(ISNULL(T0.Phone1,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone1,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone1,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Phone2,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone2,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone2,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Cellular,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Cellular,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Cellular,10)

                            ELSE '9999999999'
                        END AS MobileNumber,
                        ISNULL(T0.E_Mail,'') AS Email,
                        ISNULL(T0.U_GSTIN,'') AS GSTNo,
                        CASE WHEN T0.validFor = 'Y' THEN 1 ELSE 0 END AS IsActive,
                        '' AS GstStatus
                    FROM [BBLive].[dbo].CRD1 T1
                    LEFT JOIN [BBLive].[dbo].OCPR C ON C.CardCode = T1.CardCode
                    WHERE T1.CardCode = T0.CardCode
                    FOR JSON PATH
                ) AS BillShipTo,
                 -- ── MST_MAP_BP_Division (FOR JSON) ────────────────────────────────────────
                (
                    SELECT
                        ISNULL(T0.UpdateTS, '')             AS MapDivisionID,
                        CAST(0 AS DECIMAL(18,2))            AS AutoApprovalCreditLimit,
                        CAST(0 AS DECIMAL(18,2))            AS AutoApprovalCreditLimitBal,
                        CAST('' AS NVARCHAR(200))           AS BPRemarks,
                        CAST(0 AS DECIMAL(18,2))            AS CreditLimit,
                        ISNULL(T0.City, '')                 AS Destination,
                        CAST(0 AS DECIMAL(18,2))            AS DiscountPer,
                        SB2.DivisionCode                    AS DivisionCode,
                        CAST(0 AS DECIMAL(18,2))            AS ExcessPer,
                        REPLACE(T0.U_Grade,'Grade','')     AS Grade,
                        CAST(1 AS INT)                      AS IsActive,
                        CAST(0 AS INT)                      AS IsOrderAutoApproval,
                        CAST(0 AS INT)                      AS Outstandingdays,
                        ISNULL(T0.U_SalPriceCode, '')       AS PriceLisCode,
                        CAST(0 AS INT)                      AS ShowLimit,
                        CAST('Uathayam' AS NVARCHAR(200))   AS TransporterName

                    FROM (
                        SELECT DISTINCT DivisionCode 
                        FROM SubBrandMap
                    ) SB2 

                    FOR JSON PATH
                ) AS MST_MAP_BP_Division,
                ------------------------------------------------------------------
                -- CONTACTS
                ------------------------------------------------------------------
                (
                    SELECT
                        CntctCode                                  AS ContactPersonID,
                        Name                                       AS ContactPersonName,
                        ISNULL(Position, 'proprietor')             AS Designation,
                         CASE 
                            WHEN LEN(RIGHT(ISNULL(T0.Phone1,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone1,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone1,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Phone2,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone2,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone2,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Cellular,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Cellular,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Cellular,10)

                            ELSE '9999999999'
                        END AS MobileNum,
                         CASE 
                            WHEN LEN(RIGHT(ISNULL(T0.Phone1,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone1,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone1,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Phone2,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Phone2,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Phone2,10)

                            WHEN LEN(RIGHT(ISNULL(T0.Cellular,''),10)) = 10 
                                AND RIGHT(ISNULL(T0.Cellular,''),10) NOT LIKE '%[^0-9]%'
                            THEN RIGHT(T0.Cellular,10)

                            ELSE '9999999999'
                        END AS WhatsAppNum,
                        E_MailL                                    AS EmailID,
                        CASE WHEN Active = 'Y' THEN 1 ELSE 0 END  AS IsActive,
                        CAST(0 AS INT)                             AS IsSendOverDueReminder,
                        SB.DivisionCode                            AS DivisionCode,
                        CAST(0 AS INT) AS PaymentSMS,
                        CAST(0 AS INT) AS PaymentEmail,
                        CAST(1 AS INT) AS PaymentWhatsapp,
                        CAST(1 AS INT) AS OrderEmail,
                        CAST(1 AS INT) AS OrderSMS,
                        CAST(1 AS INT) AS OrderWhatsapp,
                        CAST(1 AS INT) AS InvoiceWhatsapp,
                        CAST(0 AS INT) AS InvoiceEmail,
                        CAST(0 AS INT) AS InvoiceSMS,
                        CAST(0 AS INT) AS PaymentRequestSMS,
                        CAST(0 AS INT) AS PaymentRequestEmail,
                        CAST(0 AS INT) AS PaymentrequestWhatsapp,
                        CAST(0 AS INT) AS OutstandingSMS,
                        CAST(0 AS INT) AS OutstandingEmail,
                        CAST(0 AS INT) AS OutstandingWhatsapp,
                        CAST(0 AS INT) AS PaycollectionWhatsapp,
                        CAST(0 AS INT) AS DistributorWhatsapp
                    FROM [BBLive].[dbo].OCPR
                    WHERE CardCode = T0.CardCode
                    FOR JSON PATH
                ) AS Map_BpContactDetails,

                ------------------------------------------------------------------
                -- BRAND JSON MST_MAP_BP_Brand (FOR JSON)
                ------------------------------------------------------------------
                (
                    SELECT
                        SB2.SubBrandName AS Brand,
                        SB2.DivisionCode AS DivisionCode
                    FROM SubBrandMap SB2  
                    FOR JSON PATH
                ) AS MST_MAP_BP_Brand,  
                ------------------------------------------------------------------
                -- SUB BRAND JSON
                ------------------------------------------------------------------
                (
                    SELECT
                        SB2.SubBrandName,
                        SB2.DivisionCode,
                        CAST(
                            CASE SB2.DiscountColumn
                                WHEN 'U_Dis1'  THEN ISNULL(T0.U_Dis1,0)
                                WHEN 'U_Dis2'  THEN ISNULL(T0.U_Dis2,0)
                                WHEN 'U_Dis3'  THEN ISNULL(T0.U_Dis3,0)
                                WHEN 'U_Dis4'  THEN ISNULL(T0.U_Dis4,0)
                                WHEN 'U_Dis5'  THEN ISNULL(T0.U_Dis5,0)
                                WHEN 'U_Dis6'  THEN ISNULL(T0.U_Dis6,0)
                                WHEN 'U_Dis7'  THEN ISNULL(T0.U_Dis7,0)
                                WHEN 'U_Dis8'  THEN ISNULL(T0.U_Dis8,0)
                                WHEN 'U_Dis9'  THEN ISNULL(T0.U_Dis9,0)
                                WHEN 'U_Dis10' THEN ISNULL(T0.U_Dis10,0)
                                WHEN 'U_Dis11' THEN ISNULL(T0.U_Dis11,0)
                                ELSE 0
                            END
                        AS DECIMAL(18,6)) AS DiscountPer
                    FROM SubBrandMap SB2
                    FOR JSON PATH
                ) AS MST_Map_BP_SubBrand,

                ------------------------------------------------------------------
                -- DISCOUNT JSON
                ------------------------------------------------------------------
                (
                    SELECT
                        'TRADE DISCOUNT' AS DiscountName,
                        SB3.DivisionCode,
                        SB3.SubBrandName AS Brand,
                        CAST(
                            CASE SB3.DiscountColumn
                                WHEN 'U_Dis1'  THEN ISNULL(T0.U_Dis1,0)
                                WHEN 'U_Dis2'  THEN ISNULL(T0.U_Dis2,0)
                                WHEN 'U_Dis3'  THEN ISNULL(T0.U_Dis3,0)
                                WHEN 'U_Dis4'  THEN ISNULL(T0.U_Dis4,0)
                                WHEN 'U_Dis5'  THEN ISNULL(T0.U_Dis5,0)
                                WHEN 'U_Dis6'  THEN ISNULL(T0.U_Dis6,0)
                                WHEN 'U_Dis7'  THEN ISNULL(T0.U_Dis7,0)
                                WHEN 'U_Dis8'  THEN ISNULL(T0.U_Dis8,0)
                                WHEN 'U_Dis9'  THEN ISNULL(T0.U_Dis9,0)
                                WHEN 'U_Dis10' THEN ISNULL(T0.U_Dis10,0)
                                WHEN 'U_Dis11' THEN ISNULL(T0.U_Dis11,0)
                                ELSE 0
                            END
                        AS DECIMAL(18,6)) AS DiscountPer,
                        CONVERT(VARCHAR(19), CAST('2019-04-01' AS DATETIME), 126) AS FromDate,
                        CONVERT(VARCHAR(19), CAST('2030-03-31' AS DATETIME), 126) AS ToDate
                    FROM SubBrandMap SB3
                    FOR JSON PATH
                ) AS Discount_BP_Division

            FROM [BBLive].[dbo].OCRD T0
            CROSS JOIN SubBrandMap SB

            WHERE T0.CardType = 'C'
            AND T0.validFor = 'Y'
            AND T0.U_AreaCode != ''
            ${codeFilter}
            ORDER BY T0.CardCode, SB.DivisionCode, SB.SubBrandName`

        const result = await req.query(query);
        return result.recordset;

    } catch (err) {
        console.log('❌ SQL Error (BP Master):', err);
        throw err;
    }
}

async function getStockData() {
    try {
        const pool = await getPool();

        const query = `
            WITH
            JOAgg AS (
                -- Job Order pending quantity per item
                SELECT
                    jo.U_ItemCode AS ItemCode,
                    SUM(jo.PENDQTY) AS JOPendQty
                FROM
                    (
                        SELECT
                            a.DocNum,
                            b.U_ItemCode,
                            SUM(ISNULL(b.U_OrderQty, 0)) - (
                                SUM(ISNULL(b.U_AccpQty, 0)) + SUM(ISNULL(b.U_RejQty, 0))
                            ) AS PENDQTY
                        FROM
                            [BBLive].[dbo].[@INSC_OJOR] a WITH (NOLOCK)
                            LEFT JOIN [BBLive].[dbo].[@INSC_JOR1] b WITH (NOLOCK) ON a.DocEntry = b.DocEntry
                        WHERE
                            a.U_Status = 'O'
                            AND b.U_OrderQty > 0
                            AND b.U_OperName NOT IN (
                                'IRONING', 'FOLDING 6.50X11.75', 'WASHING 6.50X11.75'
                            )
                        GROUP BY
                            a.DocNum,
                            b.U_ItemCode
                    ) jo
                GROUP BY
                    jo.U_ItemCode
            ),
            POAgg AS (
                -- Purchase Order pending (open qty) per item
                SELECT
                    po.ItemCode,
                    SUM(po.RemQty) AS OpenPORemQty
                FROM
                    (
                        SELECT
                            x.DocNum,
                            x.ItemCode,
                            SUM(ISNULL(x.OrderQty, 0)) - SUM(ISNULL(x.GRNQty, 0)) AS RemQty
                        FROM
                            (
                                SELECT
                                    t0.DocNum,
                                    t1.ItemCode,
                                    t1.Quantity AS OrderQty,
                                    0 AS GRNQty
                                FROM
                                    [BBLive].[dbo].OPOR t0 WITH (NOLOCK)
                                    INNER JOIN [BBLive].[dbo].POR1 t1 WITH (NOLOCK) ON t0.DocEntry = t1.DocEntry
                                WHERE
                                    t0.DocStatus = 'O'
                                    AND t1.LineStatus = 'O'
                                    AND t0.CANCELED = 'N'
                                UNION ALL
                                SELECT
                                    t0.DocNum,
                                    t1.ItemCode,
                                    0 AS OrderQty,
                                    ISNULL(t2.Quantity, 0) AS GRNQty
                                FROM
                                    [BBLive].[dbo].OPOR t0 WITH (NOLOCK)
                                    INNER JOIN [BBLive].[dbo].POR1 t1 WITH (NOLOCK) ON t0.DocEntry = t1.DocEntry
                                    LEFT JOIN [BBLive].[dbo].PDN1 t2 WITH (NOLOCK) ON t2.BaseEntry = t1.DocEntry
                                        AND t2.BaseType = '22'
                                        AND t2.ItemCode = t1.ItemCode
                                        AND t2.BaseLine = t1.LineNum
                                        AND t2.DocEntry IN (
                                            SELECT DocEntry
                                            FROM [BBLive].[dbo].OPDN WITH (NOLOCK)
                                            WHERE CANCELED = 'N'
                                        )
                                WHERE
                                    t0.DocStatus = 'O'
                                    AND t1.LineStatus = 'O'
                                    AND t0.CANCELED = 'N'
                            ) x
                        GROUP BY
                            x.DocNum,
                            x.ItemCode
                        HAVING
                            SUM(ISNULL(x.OrderQty, 0)) - SUM(ISNULL(x.GRNQty, 0)) > 0
                    ) po
                GROUP BY
                    po.ItemCode
            ),
            SOAgg AS (
                -- Pending Sales Order quantity per item
                SELECT
                    y.ItemCode,
                    SUM(ISNULL(y.OpenCreQty, 0)) AS PendingSOQty
                FROM
                    [BBLive].[dbo].ORDR x WITH (NOLOCK)
                    INNER JOIN [BBLive].[dbo].RDR1 y WITH (NOLOCK) ON x.DocEntry = y.DocEntry
                WHERE
                    x.DocStatus = 'O'
                    AND y.LineStatus = 'O'
                GROUP BY
                    y.ItemCode
            ),
            StockAgg AS (
                -- Collapses OITW to ONE row per item
                SELECT
                    t1.ItemCode,
                    SUM(t1.OnHand) AS TotalOnHand
                FROM
                    [BBLive].[dbo].OITW t1 WITH (NOLOCK)
                    INNER JOIN [BBLive].[dbo].OWHS t2 WITH (NOLOCK) ON t2.WhsCode = t1.WhsCode
                WHERE
                    t2.GlblLocNum = 1
                GROUP BY
                    t1.ItemCode
            )
        SELECT
            t0.DocEntry AS ExternalId,
            t0.DocEntry AS ProductMappingId,
            t0.ItemCode AS ProductCode,
            ISNULL(t0.U_SubGrp6, t0.U_SubGrp11) AS ColorCode,
            t0.U_SubGrp7 AS AttributeValue,
            t0.U_SubGrp4 AS StyleCode,
            RTRIM(t0.U_SubGrp5) AS Size,
            CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END AS StockQuantity,
            'Stock' AS Type,
            CASE WHEN t0.ValidFor = 'Y' THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS IsActive,
            CAST(t0.U_Runnout AS NVARCHAR(10)) AS RunningOutFlag,
            ISNULL(jo.JOPendQty, 0) AS JOPendingQty,
            ISNULL(po.OpenPORemQty, 0) AS POPendingQty,
            ISNULL(so.PendingSOQty, 0) AS SOPendingQty,
            -- ===== Four-stage stock category =====
            CASE
                -- 1. Unavailable
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END + ISNULL(jo.JOPendQty, 0) + ISNULL(po.OpenPORemQty, 0) - ISNULL(so.PendingSOQty, 0)) < 0
                    AND CAST(t0.U_Runnout AS NVARCHAR(10)) = 'Yes' THEN 'Unavailable'
                -- 2. Excess Order
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END + ISNULL(jo.JOPendQty, 0) + ISNULL(po.OpenPORemQty, 0) - ISNULL(so.PendingSOQty, 0)) < 0
                    AND (CAST(t0.U_Runnout AS NVARCHAR(10)) <> 'Yes' OR t0.U_Runnout IS NULL) THEN 'Excess Order'
                -- 3. In Stock - High
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END - ISNULL(so.PendingSOQty, 0)) > 1000 THEN 'In Stock'
                -- 4. In Stock - Low
                ELSE 'Low Stock'
            END AS StockCategory,
            CASE
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END + ISNULL(jo.JOPendQty, 0) + ISNULL(po.OpenPORemQty, 0) - ISNULL(so.PendingSOQty, 0)) < 0
                    AND CAST(t0.U_Runnout AS NVARCHAR(10)) = 'Yes' THEN 'Unavailable'
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END + ISNULL(jo.JOPendQty, 0) + ISNULL(po.OpenPORemQty, 0) - ISNULL(so.PendingSOQty, 0)) < 0
                    AND (CAST(t0.U_Runnout AS NVARCHAR(10)) <> 'Yes' OR t0.U_Runnout IS NULL) THEN 'Excess Order'
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END - ISNULL(so.PendingSOQty, 0)) > 1000 THEN 'In Stock'
                ELSE 'Low Stock'
            END AS StockHighlightMessageDetails,
            CASE
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END + ISNULL(jo.JOPendQty, 0) + ISNULL(po.OpenPORemQty, 0) - ISNULL(so.PendingSOQty, 0)) < 0
                    AND CAST(t0.U_Runnout AS NVARCHAR(10)) = 'Yes' THEN 'Unavailable'
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END + ISNULL(jo.JOPendQty, 0) + ISNULL(po.OpenPORemQty, 0) - ISNULL(so.PendingSOQty, 0)) < 0
                    AND (CAST(t0.U_Runnout AS NVARCHAR(10)) <> 'Yes' OR t0.U_Runnout IS NULL) THEN 'Excess Order'
                WHEN (CASE WHEN t0.ItemType = 'S' THEN t3.Stock ELSE ISNULL(stk.TotalOnHand, 0) END - ISNULL(so.PendingSOQty, 0)) > 1000 THEN 'In Stock'
                ELSE 'Low Stock'
            END AS StockMessage
        FROM
            [BBLive].[dbo].OITM AS t0 WITH (NOLOCK)
            LEFT JOIN StockAgg stk ON stk.ItemCode = t0.ItemCode
            LEFT JOIN [BBLive].[dbo].setstockall AS t3 WITH (NOLOCK) ON t0.ItemCode = t3.Code
            LEFT JOIN JOAgg jo ON jo.ItemCode = t0.ItemCode
            LEFT JOIN POAgg po ON po.ItemCode = t0.ItemCode
            LEFT JOIN SOAgg so ON so.ItemCode = t0.ItemCode
        WHERE
            t0.ValidFor = 'Y'
            AND t0.U_SubGrp1 NOT IN (
                'ACCESSORIES', 'ADVERTISEMENT', 'ALL',
                'SAMPLE', 'PRINTING & STATIONERY',
                'IMPERIAL COMPUTERS', 'PACKING MATERIAL',
                'REPAIRS & MAINTENANCE', 'SALES PROMOTION EXPENSES',
                'EVERYDAY DHOTIE', 'ALLDAYS DHOTIE',
                'ADD DHOTIE', 'ADD SHIRT', 'EVERYDAY SHIRTING',
                'EVERYDAY RDY'
            )
            --AND ISNULL(stk.TotalOnHand, 0) > 0
        ORDER BY
            t0.ItemCode;
        `;

        const { recordset } = await pool.request().query(query);
        return recordset;

    } catch (err) {
        console.error('❌ SQL Error (Stock):', err);
        throw err;
    }
}

async function getOutstandingData() {
    try {
        const pool = await getPool();

        const query = `
            SELECT
                CASE
                    WHEN tk.U_Brand LIKE '%UATHAYAM%' THEN 'UATHAYAM'
                    ELSE 'ARISER'
                END AS DivisionCode,
                CAST(tk.DocEntry AS NVARCHAR(20)) AS DocEntry,
                CASE
                    WHEN tk.U_Brand LIKE '%UATHAYAM%' THEN 'UATHAYAM'
                    ELSE 'ARISER'
                END AS DivisionName,
                tk.U_Brand AS Brand,
                CASE
                    WHEN k.TransType = '13' THEN 'AR Invoice'
                    WHEN k.TransType = '30' THEN 'Journal'
                    ELSE NULL
                END AS DocType,
                CASE
                    WHEN k.Ref1 NOT LIKE '%[^0-9]%' AND k.Ref1 IS NOT NULL
                    THEN CAST(k.Ref1 AS INT)
                    ELSE NULL
                END AS InvoiceNo,
                tk.DocDate AS InvoiceDate,
                k.duedat AS DueDate,
                k.CardCode AS CardCode,
                k.CardName AS CardName,
                lk.City AS City,
                lk.State AS STATE,
                k.memo AS DocumentRemarks,
                CASE
                    WHEN k.BalDueDeb > 0 THEN DATEDIFF(d, k.duedat, GETDATE())
                    ELSE 0
                END AS OverdueDays,
                GETDATE() AS OverdueDate,
                CASE
                    WHEN k.TransType = '30' THEN k.Debit
                    ELSE ISNULL(tk.DocTotal, 0)
                END AS DocumentValue,
                k.BalDueDeb AS BalanceToBePaid,
                CAST(0 AS BIT) AS BatchEnd
            FROM (
                SELECT
                    T2.CardCode,
                    T2.CardName,
                    T0.RefDate,
                    T1.BaseRef,
                    T1.Debit,
                    T1.Credit,
                    T0.TransId,
                    T1.BalDueDeb,
                    T1.LineMemo,
                    T2.MailCity,
                    T3.GroupName,
                    T1.Ref1,
                    CASE
                        WHEN T1.TransType IN ('-2', '30') THEN T1.DueDate
                        ELSE T0.RefDate
                    END AS duedat,
                    T1.OcrCode3 AS brand,
                    T0.memo,
                    T0.TransType
                FROM [BBLive].[dbo].OJDT T0
                INNER JOIN [BBLive].[dbo].JDT1 T1 ON T0.TransId = T1.TransId
                INNER JOIN [BBLive].[dbo].OCRD T2 ON T2.CardCode = T1.ShortName
                INNER JOIN [BBLive].[dbo].OCRG T3 ON T2.GroupCode = T3.GroupCode
                WHERE T1.BalDueDeb <> '0'
                  AND T2.CardType = 'C'
            ) k
            LEFT JOIN (
                SELECT
                    tl.DocNum,
                    tl.DocEntry,
                    tl.DocDate,
                    tl.DocTotal,
                    tl.CardCode,
                    tl.U_Brand,
                    tg.U_Remarks,
                    tl.TransId
                FROM [BBLive].[dbo].OINV tl
                LEFT JOIN [BBLive].[dbo].[@INCM_BND1] tg ON tg.U_Name = RTRIM(tl.U_Brand)
            ) tk ON CONVERT(NVARCHAR(20), tk.DocNum) = k.Ref1
                 AND tk.CardCode = k.CardCode
                 AND tk.TransId = k.TransId
            LEFT JOIN (
                SELECT
                    cr1.CardCode,
                    cr1.CardName,
                    cr1.U_AreaCode AS agent,
                    cr2.City,
                    cr2.State
                FROM [BBLive].[dbo].OCRD cr1
                LEFT JOIN [BBLive].[dbo].CRD1 cr2 ON cr2.CardCode = cr1.CardCode
                                   AND cr2.AdresType = 'B'
            ) lk ON lk.CardCode = k.CardCode
        `;

        const { recordset } = await pool.request().query(query);
        return recordset;

    } catch (err) {
        console.error('SQL Error (Outstanding):', err);
        throw err;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paginated product list with push status joined from [SFA_RecordPushStatus]
// opts: { page, limit, search, pushStatus, division }
// Returns: { data, total, page, limit, totalPages, summary }
// ─────────────────────────────────────────────────────────────────────────────
async function getProductsPaged({ page = 1, limit = 50, search, pushStatus, division, productGroup } = {}) {
    const pool   = await getPool();
    const offset = (page - 1) * limit;

    const searchVal   = search       ? `%${search}%` : null;
    const divVal      = division     || null;
    const statusVal   = pushStatus   || null;
    const groupVal    = productGroup || null;

    const dataQuery = `
        SELECT
            COUNT(*) OVER() AS TotalCount,
            t0.ItemCode                                                     AS ProductCode,
            t0.ItemName                                                     AS ProductName,
            CASE WHEN t0.U_SFAItemActiveStatus = 'Yes' THEN 0 ELSE 1 END AS ProductIsActive,
            t0.U_SubGrp7                                                    AS ProductGroupCode,
            t0.U_SubGrp1                                                    AS Brand,
            t0.U_SubGrp3                                                    AS CategoryName,
            t0.U_SubGrp4                                                    AS StyleCode,
            RTRIM(t0.U_SubGrp5)                                             AS SizeCode,
            RTRIM(t0.U_SubGrp6)                                             AS ColorCode,
            ISNULL(t0.U_SubGrp11, t0.U_SubGrp6)                            AS ColorName,
            t0.SalPackMsr                                                   AS UOM,
            t0.U_HSNCODE                                                    AS HSNCode,
            t0.U_taxrate                                                    AS TaxBelow2500,
            t0.U_taxrate1000                                                AS TaxAbove2500,
            CASE
                WHEN t0.U_SubGrp1 LIKE '%ARISER%'   THEN 'ARISER'
                WHEN t0.U_SubGrp1 LIKE '%UATHAYAM%' THEN 'UATHAYAM'
            END                                                             AS DivisionCode,
            ISNULL(ps.PushStatus, 'Pending')                               AS PushStatus,
            ps.LastPushedAt,
            ps.ErrorMessage                                                 AS PushError,
            ps.UpdatedAt                                                    AS StatusUpdatedAt
        FROM [BBLive].[dbo].oitm t0
        JOIN [BBLive].[dbo].oitb t1 ON t0.ItmsGrpCod = t1.ItmsGrpCod
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] ps
            ON ps.MasterType = 'products' AND ps.RecordKey = t0.ItemCode
        WHERE EXISTS (
            SELECT 1 FROM [BBLive].[dbo]."@INS_OPLM" plm
            INNER JOIN [BBLive].[dbo]."@INS_PLM2" plm2 ON plm2.DocEntry = plm.DocEntry
            WHERE plm.U_ItemCode = t0.ItemCode AND plm2.U_SelPrice > 0
        )
        AND t0.validFor = 'Y'
        AND t0.U_SubGrp1 NOT IN (
            'ACCESSORIES','ADVERTISEMENT','ALL','SAMPLE','PRINTING & STATIONERY',
            'IMPERIAL COMPUTERS','PACKING MATERIAL','REPAIRS & MAINTENANCE',
            'SALES PROMOTION EXPENSES','EVERYDAY DHOTIE','ALLDAYS DHOTIE',
            'ADD DHOTIE','ADD SHIRT','EVERYDAY SHIRTING','EVERYDAY RDY'
        )
        AND (@search    IS NULL OR t0.ItemCode LIKE @search OR t0.ItemName LIKE @search)
        AND (@division  IS NULL OR (
                (@division = 'ARISER'   AND t0.U_SubGrp1 LIKE '%ARISER%'  ) OR
                (@division = 'UATHAYAM' AND t0.U_SubGrp1 LIKE '%UATHAYAM%')
        ))
        AND (@productGroup IS NULL OR t0.U_SubGrp7 = @productGroup)
        AND (@pushStatus IS NULL OR ISNULL(ps.PushStatus, 'Pending') = @pushStatus)
        ORDER BY t0.ItemCode
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const summaryQuery = `
        SELECT ISNULL(ps.PushStatus, 'Pending') AS PushStatus, COUNT(*) AS Count
        FROM [BBLive].[dbo].oitm t0
        JOIN [BBLive].[dbo].oitb t1 ON t0.ItmsGrpCod = t1.ItmsGrpCod
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] ps
            ON ps.MasterType = 'products' AND ps.RecordKey = t0.ItemCode
        WHERE EXISTS (
            SELECT 1 FROM [BBLive].[dbo]."@INS_OPLM" plm
            INNER JOIN [BBLive].[dbo]."@INS_PLM2" plm2 ON plm2.DocEntry = plm.DocEntry
            WHERE plm.U_ItemCode = t0.ItemCode AND plm2.U_SelPrice > 0
        )
        AND t0.validFor = 'Y'
        AND t0.U_SubGrp1 NOT IN (
            'ACCESSORIES','ADVERTISEMENT','ALL','SAMPLE','PRINTING & STATIONERY',
            'IMPERIAL COMPUTERS','PACKING MATERIAL','REPAIRS & MAINTENANCE',
            'SALES PROMOTION EXPENSES','EVERYDAY DHOTIE','ALLDAYS DHOTIE',
            'ADD DHOTIE','ADD SHIRT','EVERYDAY SHIRTING','EVERYDAY RDY'
        )
        GROUP BY ISNULL(ps.PushStatus, 'Pending')
    `;

    const [dataRes, summaryRes] = await Promise.all([
        pool.request()
            .input('search',       sql.NVarChar(200), searchVal)
            .input('division',     sql.NVarChar(50),  divVal)
            .input('productGroup', sql.NVarChar(50),  groupVal)
            .input('pushStatus',   sql.NVarChar(20),  statusVal)
            .input('offset',       sql.Int,           offset)
            .input('limit',        sql.Int,           limit)
            .query(dataQuery),
        pool.request().query(summaryQuery)
    ]);

    const records = dataRes.recordset;
    const total   = records.length > 0 ? records[0].TotalCount : 0;

    // Build summary map
    const summaryMap = { Pending: 0, Pushing: 0, Pushed: 0, Failed: 0 };
    for (const row of summaryRes.recordset) {
        summaryMap[row.PushStatus] = row.Count;
    }
    // Records with no push status row count as Pending
    const trackedTotal = Object.values(summaryMap).reduce((a, b) => a + b, 0);

    return {
        data:       records.map(({ TotalCount, ...rest }) => rest),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        summary:    summaryMap,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Distinct Product Group values (U_SubGrp7) — used to populate the Product
// Group filter dropdown on the Product Master and Price List screens.
// ─────────────────────────────────────────────────────────────────────────────
async function getProductGroups() {
    const pool = await getPool();

    const result = await pool.request().query(`
        SELECT DISTINCT RTRIM(t0.U_SubGrp7) AS ProductGroupCode
        FROM [BBLive].[dbo].oitm t0
        WHERE t0.validFor = 'Y'
          AND t0.U_SubGrp7 IS NOT NULL
          AND RTRIM(t0.U_SubGrp7) <> ''
          AND t0.U_SubGrp1 NOT IN (
              'ACCESSORIES','ADVERTISEMENT','ALL','SAMPLE','PRINTING & STATIONERY',
              'IMPERIAL COMPUTERS','PACKING MATERIAL','REPAIRS & MAINTENANCE',
              'SALES PROMOTION EXPENSES','EVERYDAY DHOTIE','ALLDAYS DHOTIE',
              'ADD DHOTIE','ADD SHIRT','EVERYDAY SHIRTING','EVERYDAY RDY'
          )
        ORDER BY ProductGroupCode
    `);

    return result.recordset.map(r => r.ProductGroupCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch full product rows for specific product codes (used before SF push)
// ─────────────────────────────────────────────────────────────────────────────
async function getProductDataByCodes(productCodes) {
    if (!productCodes || productCodes.length === 0) return [];
    const pool = await getPool();

    const req          = pool.request();
    const placeholders = productCodes.map((code, i) => {
        req.input(`c${i}`, sql.NVarChar(50), code);
        return `@c${i}`;
    }).join(',');

    const query = `
        SELECT
            t0.ItemCode AS ProductCode,
            t0.ItemName AS ProductName,
            CASE WHEN t0.U_SFAItemActiveStatus = 'Yes' THEN 0 ELSE 1 END AS ProductIsActive,
            t0.U_SubGrp7  AS ProductGroupCode,
            t0.U_SubGrp7  AS ShortDesc,
            t0.ItemName   AS DetailedDesc,
            t0.U_SubGrp3  AS CategoryName,
            t0.U_SubGrp4  AS StyleCode,
            RTRIM(t0.U_SubGrp5) AS SizeCode,
            CASE
                WHEN t0.U_SubGrp1 LIKE '%ARISER%'   THEN 'ARISER'
                WHEN t0.U_SubGrp1 LIKE '%UATHAYAM%' THEN 'UATHAYAM'
            END AS DivisionCode,
            t0.SalPackMsr AS UOM,
            t0.U_SubGrp3  AS AttributeSetName,
            RTRIM(t0.U_SubGrp5)  AS SizeGroup,
            t0.U_HSNCODE  AS HSNCode,
            t0.U_SubGrp1  AS Brand,
            t0.SalPackUn  AS SalPackUn,
            RTRIM(t0.U_SubGrp6)  AS ColorCode,
            ISNULL(t0.U_SubGrp11, T0.U_SUBGRP6) AS ColorName,
            ISNULL(t0.U_SubGrp17, T0.U_SubGrp6) AS Color,
            ISNULL(t0.U_SubGrp13, T0.U_SubGrp6) AS Shade,
            t0.MinLevel   AS Min_Qty,
            t0.MaxLevel   AS Max_Qty,
            CASE WHEN t0.U_SubGrp13='Core item' THEN 1 ELSE 0 END AS IsCoreColor,
            t0.U_taxrate  AS TaxBelow2500,
            t0.U_taxrate1000 AS TaxAbove2500,
            t0.U_SubGrp1  AS SubBrandCode
        FROM [BBLive].[dbo].oitm t0
        JOIN [BBLive].[dbo].oitb t1 ON t0.ItmsGrpCod = t1.ItmsGrpCod
        WHERE t0.ItemCode IN (${placeholders})
        ORDER BY t0.ItemCode
    `;

    const result = await req.query(query);
    return result.recordset;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT SCHEDULER TRIGGER — AITM.U_SFATriggerStatus drives one-item-at-a-time
// processing: NULL/'N' = pending, 'Y' = already synced.
// ─────────────────────────────────────────────────────────────────────────────
async function getNextPendingProductTrigger() {
    const pool = await getPool();

    const result = await pool.request().query(`
        SELECT TOP 1 ItemCode, ItemName
        FROM AITM
        WHERE U_SFATriggerStatus IS NULL
           OR U_SFATriggerStatus = 'N'
        ORDER BY ItemCode
    `);

    return result.recordset[0] || null;
}

async function markProductTriggerSynced(itemCode) {
    const pool = await getPool();

    await pool.request()
        .input('ItemCode', sql.NVarChar(50), itemCode)
        .query(`
            UPDATE AITM
            SET U_SFATriggerStatus = 'Y'
            WHERE ItemCode = @ItemCode
        `);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE LISTS — paged list + full data by codes
//
// Shares the same two-source, priority-ranked pricing logic as getPriceListData()
// above (size-level @INS_OPLSN preferred, item-level @INS_PLM2/OPLM/PLM1 as
// fallback, locked/zero-MRP rows excluded) so the grid and single/selected-record
// sync paths never disagree with the full "Sync All" price. getPriceListData()
// itself is left untouched to avoid any risk to that already-working path.
// ─────────────────────────────────────────────────────────────────────────────
const PRICE_EXCLUDED_BRANDS = `'ACCESSORIES','ADVERTISEMENT','ALL','SAMPLE','PRINTING & STATIONERY',
    'IMPERIAL COMPUTERS','PACKING MATERIAL','REPAIRS & MAINTENANCE',
    'SALES PROMOTION EXPENSES','EVERYDAY DHOTIE','ALLDAYS DHOTIE',
    'ADD DHOTIE','ADD SHIRT','EVERYDAY SHIRTING','EVERYDAY RDY'`;

function buildRankedPriceCte(itemCodeFilter = '') {
    return `
        WITH itempriced AS (
            SELECT T1.u_itemcode, T0.docentry, T2.u_brand, T0.u_state, T0.u_selprice, T0.u_mrp, T2.u_lock, T0.lineid, T2.u_catalgcode
            FROM [BBLive].[dbo].[@ins_plm2] T0 WITH (nolock)
            INNER JOIN [BBLive].[dbo].[@ins_oplm] T1 WITH (nolock) ON T0.docentry = T1.docentry
            INNER JOIN [BBLive].[dbo].[@ins_plm1] T2 WITH (nolock) ON T0.docentry = T2.docentry AND T2.lineid = T0.u_rowid
            WHERE T2.u_lock = 'N' AND T0.u_mrp > 0
            ${itemCodeFilter ? `AND T1.u_itemcode ${itemCodeFilter}` : ''}
        ),
        sizepriced AS (
            SELECT T1b.u_subgroup1, T1b.u_subgroup7, T1b.u_subgroup4, T3b.u_size, T0b.docentry,
                   T1b.U_SubGroup1 AS U_Brand, CAST(T2b.u_code AS VARCHAR(50)) AS U_State,
                   T3b.u_selprice, T3b.u_mrp, 'N' AS U_Lock, T1b.lineid, CAST(NULL AS VARCHAR(50)) AS U_CatalgCode
            FROM [BBLive].[dbo].[@ins_oplsn] T0b WITH (nolock)
            INNER JOIN [BBLive].[dbo].[@ins_plsn1] T1b WITH (nolock) ON T0b.docentry = T1b.docentry
            INNER JOIN [BBLive].[dbo].[@ins_plsn3] T3b WITH (nolock) ON T0b.docentry = T3b.docentry AND T1b.lineid = T3b.u_uniqid
            INNER JOIN [BBLive].[dbo].[@ins_plsn2] T2b WITH (nolock) ON T0b.docentry = T2b.docentry AND T2b.u_selected = 'Y'
            WHERE GETDATE() BETWEEN T0b.u_validfrom AND T0b.u_validto AND T3b.u_mrp > 0
        ),
        combined AS (
            SELECT t0.itemcode AS ProductCode, B.docentry AS PriceListID, B.u_state AS SubBrandCode,
                   CASE WHEN t0.u_subgrp1 = 'UATHAYAM DHOTIE' THEN B.u_catalgcode ELSE t0.itemname END AS BPProductName,
                   t0.itemname AS ProductName,
                   B.u_state AS PriceListCode, NULL AS EffectiveFrom, NULL AS EffectiveTo,
                   CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END AS PriceListIsActive, 'Dealer' AS BPCategory,
                   B.u_selprice AS Price, B.u_mrp AS MRP, B.lineid AS PriceID,
                   CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END AS PriceIsActive,
                   t0.u_subgrp7 AS ProductGroupCode, t0.u_subgrp1 AS Brand, 1 AS SourcePriority
            FROM [BBLive].[dbo].oitm t0 WITH (nolock)
            INNER JOIN sizepriced B
                ON B.u_subgroup7 = t0.u_subgrp7 AND B.u_subgroup4 = t0.u_subgrp4
                   AND B.u_subgroup1 = t0.u_subgrp1 AND B.u_size = t0.u_subgrp5
            WHERE B.u_selprice > 0 AND B.u_brand NOT IN (${PRICE_EXCLUDED_BRANDS}) AND t0.validfor = 'Y'
            ${itemCodeFilter ? `AND t0.itemcode ${itemCodeFilter}` : ''}
            UNION ALL
            SELECT t0.itemcode, B.docentry, B.u_state,
                   CASE WHEN t0.u_subgrp1 = 'UATHAYAM DHOTIE' THEN B.u_catalgcode ELSE t0.itemname END,
                   t0.itemname,
                   B.u_state, NULL, NULL,
                   CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END, 'Dealer',
                   B.u_selprice, B.u_mrp, B.lineid,
                   CASE WHEN B.u_lock = 'Y' THEN 0 ELSE 1 END,
                   t0.u_subgrp7, t0.u_subgrp1, 2
            FROM [BBLive].[dbo].oitm t0 WITH (nolock)
            INNER JOIN itempriced B ON B.u_itemcode = t0.itemcode
            WHERE B.u_selprice > 0 AND B.u_brand NOT IN (${PRICE_EXCLUDED_BRANDS}) AND t0.validfor = 'Y'
            ${itemCodeFilter ? `AND t0.itemcode ${itemCodeFilter}` : ''}
        ),
        ranked AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY ProductCode, SubBrandCode ORDER BY SourcePriority) AS rn
            FROM combined
        )
    `;
}

async function getPriceListsPaged({ page = 1, limit = 50, search, pushStatus, productGroup } = {}) {
    const pool       = await getPool();
    const offset     = (page - 1) * limit;
    const searchVal  = search       ? `%${search}%` : null;
    const statusVal  = pushStatus   || null;
    const groupVal   = productGroup || null;

    const dataQuery = `
        ${buildRankedPriceCte()}
        , PriceSummary AS (
            SELECT
                ProductCode,
                MAX(ProductName)      AS ProductName,
                MAX(Brand)            AS Brand,
                MAX(ProductGroupCode) AS ProductGroupCode,
                COUNT(*)                    AS PriceEntries,
                COUNT(DISTINCT SubBrandCode) AS StateCount,
                MIN(Price)             AS MinPrice,
                MAX(Price)             AS MaxPrice
            FROM ranked
            WHERE rn = 1
            GROUP BY ProductCode
        )
        SELECT
            COUNT(*) OVER()                        AS TotalCount,
            ps.ProductCode, ps.ProductName, ps.Brand, ps.ProductGroupCode,
            ps.PriceEntries, ps.StateCount, ps.MinPrice, ps.MaxPrice,
            ISNULL(rp.PushStatus, 'Pending')       AS PushStatus,
            rp.LastPushedAt,
            rp.ErrorMessage                        AS PushError
        FROM PriceSummary ps
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType = 'pricelists' AND rp.RecordKey = ps.ProductCode
        WHERE (@search IS NULL OR ps.ProductCode LIKE @search OR ps.ProductName LIKE @search OR ps.Brand LIKE @search)
          AND (@productGroup IS NULL OR ps.ProductGroupCode = @productGroup)
          AND (@pushStatus IS NULL OR ISNULL(rp.PushStatus, 'Pending') = @pushStatus)
        ORDER BY ps.ProductCode
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const summaryQuery = `
        ${buildRankedPriceCte()}
        SELECT ISNULL(rp.PushStatus, 'Pending') AS PushStatus, COUNT(*) AS Count
        FROM (
            SELECT DISTINCT ProductCode FROM ranked WHERE rn = 1
        ) base
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType = 'pricelists' AND rp.RecordKey = base.ProductCode
        GROUP BY ISNULL(rp.PushStatus, 'Pending')
    `;

    const [dataRes, summaryRes] = await Promise.all([
        pool.request()
            .input('search',       sql.NVarChar(200), searchVal)
            .input('productGroup', sql.NVarChar(50),  groupVal)
            .input('pushStatus',   sql.NVarChar(20),  statusVal)
            .input('offset',       sql.Int,           offset)
            .input('limit',        sql.Int,           limit)
            .query(dataQuery),
        pool.request().query(summaryQuery),
    ]);

    const records = dataRes.recordset;
    const total   = records.length > 0 ? records[0].TotalCount : 0;
    const summaryMap = { Pending: 0, Pushing: 0, Pushed: 0, Failed: 0 };
    for (const row of summaryRes.recordset) summaryMap[row.PushStatus] = row.Count;

    return {
        data:       records.map(({ TotalCount, ...rest }) => rest),
        total, page, limit,
        totalPages: Math.ceil(total / limit),
        summary:    summaryMap,
    };
}

async function getPriceListDataByCodes(productCodes) {
    if (!productCodes || productCodes.length === 0) return [];
    const pool = await getPool();
    const req  = pool.request();
    const placeholders = productCodes.map((c, i) => { req.input(`c${i}`, sql.NVarChar(50), c); return `@c${i}`; }).join(',');

    const query = `
        ${buildRankedPriceCte(`IN (${placeholders})`)}
        SELECT
            ProductCode, PriceListID, SubBrandCode, BPProductName, PriceListCode,
            EffectiveFrom, EffectiveTo, PriceListIsActive, BPCategory, Price, MRP, PriceID, PriceIsActive
        FROM ranked
        WHERE rn = 1
        ORDER BY ProductCode, SubBrandCode
    `;
    const result = await req.query(query);
    return result.recordset;
}

const PRICE_SORT_COLUMNS = {
    ProductCode: 'ProductCode',
    ProductName: 'ProductName',
    Price:       'Price',
    MRP:         'MRP',
    SubBrandCode: 'SubBrandCode',
};

// ─────────────────────────────────────────────────────────────────────────────
// PRICE LISTS — row-level paged listing (one row per ProductCode+SubBrandCode),
// for the dedicated Price List screen. Uses the same corrected/ranked source as
// getPriceListData()/getPriceListDataByCodes() above — never aggregated.
// ─────────────────────────────────────────────────────────────────────────────
async function getPriceListRowsPaged({
    page = 1, limit = 50, search, productGroup, subBrand, activeOnly, sortBy, sortDir,
} = {}) {
    const pool       = await getPool();
    const offset     = (page - 1) * limit;
    const searchVal  = search       ? `%${search}%` : null;
    const groupVal   = productGroup || null;
    const subBrandVal = subBrand    || null;

    const orderCol = PRICE_SORT_COLUMNS[sortBy] || 'ProductCode';
    const orderDir = String(sortDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const query = `
        ${buildRankedPriceCte()}
        SELECT
            COUNT(*) OVER()        AS TotalCount,
            r.ProductCode, r.ProductName, r.Brand, r.ProductGroupCode,
            r.PriceListID, r.SubBrandCode, r.PriceListCode, r.BPProductName,
            r.Price, r.MRP, r.PriceID, r.PriceListIsActive, r.PriceIsActive,
            ISNULL(rp.PushStatus, 'Pending') AS PushStatus,
            rp.LastPushedAt,
            rp.ErrorMessage                  AS PushError
        FROM ranked r
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType = 'pricelists' AND rp.RecordKey = r.ProductCode
        WHERE r.rn = 1
          AND (@search IS NULL OR r.ProductCode LIKE @search OR r.ProductName LIKE @search OR r.Brand LIKE @search)
          AND (@productGroup IS NULL OR r.ProductGroupCode = @productGroup)
          AND (@subBrand IS NULL OR r.SubBrandCode = @subBrand)
          ${activeOnly ? 'AND r.PriceListIsActive = 1' : ''}
        ORDER BY r.${orderCol} ${orderDir}, r.SubBrandCode ASC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const { recordset } = await pool.request()
        .input('search',       sql.NVarChar(200), searchVal)
        .input('productGroup', sql.NVarChar(50),  groupVal)
        .input('subBrand',     sql.NVarChar(50),  subBrandVal)
        .input('offset',       sql.Int,           offset)
        .input('limit',        sql.Int,           limit)
        .query(query);

    const total = recordset.length > 0 ? recordset[0].TotalCount : 0;
    return {
        data:       recordset.map(({ TotalCount, ...rest }) => rest),
        total, page, limit,
        totalPages: Math.ceil(total / limit),
    };
}

// Lightweight — distinct state codes only, deliberately NOT routed through the
// full ranked-price CTE (that computes pricing for the whole catalog, which is
// wasteful and was observed to get the DB session killed when run back-to-back
// with another full-catalog query for what is just a ~30-value dropdown list).
async function getPriceListStates() {
    const pool = await getPool();
    const query = `
        SELECT DISTINCT state FROM (
            SELECT CAST(u_code AS VARCHAR(50)) AS state
            FROM [BBLive].[dbo].[@ins_plsn2] WITH (nolock)
            WHERE u_selected = 'Y'
            UNION
            SELECT u_state AS state
            FROM [BBLive].[dbo].[@ins_plm2] WITH (nolock)
            WHERE u_state IS NOT NULL AND u_state <> ''
        ) x
        WHERE state IS NOT NULL AND state <> ''
        ORDER BY state
    `;
    const { recordset } = await pool.request().query(query);
    return recordset.map(r => r.state);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS PARTNERS — paged list + full data by codes
// ─────────────────────────────────────────────────────────────────────────────
async function getBPListPaged({ page = 1, limit = 50, search, pushStatus } = {}) {
    const pool      = await getPool();
    const offset    = (page - 1) * limit;
    const searchVal = search     ? `%${search}%` : null;
    const statusVal = pushStatus || null;

    const dataQuery = `
        SELECT
            COUNT(*) OVER()                             AS TotalCount,
            T0.CardCode                                 AS BPCode,
            T0.CardName                                 AS BPName,
            CASE WHEN T0.GroupCode IN ('100','106') THEN 'Dealer' ELSE '' END AS BPCategory,
            T0.U_AreaCode                               AS AreaCode,
            CASE
                WHEN ISNULL(T0.U_Grade,'') IN ('','-') THEN 'C'
                ELSE REPLACE(T0.U_Grade,'Grade','')
            END                                         AS GradeOfBP,
            ISNULL(T0.U_GSTIN,'')                       AS GSTNo,
            CASE
                WHEN LEN(RIGHT(ISNULL(T0.Phone1,''),10))=10
                 AND RIGHT(ISNULL(T0.Phone1,''),10) NOT LIKE '%[^0-9]%' THEN RIGHT(T0.Phone1,10)
                WHEN LEN(RIGHT(ISNULL(T0.Phone2,''),10))=10
                 AND RIGHT(ISNULL(T0.Phone2,''),10) NOT LIKE '%[^0-9]%' THEN RIGHT(T0.Phone2,10)
                ELSE ''
            END                                         AS Phone1,
            (SELECT TOP 1 City FROM [BBLive].[dbo].CRD1
             WHERE CardCode=T0.CardCode AND AdresType='B') AS City,
            ISNULL(rp.PushStatus,'Pending')             AS PushStatus,
            rp.LastPushedAt,
            rp.ErrorMessage                             AS PushError
        FROM [BBLive].[dbo].OCRD T0
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType = 'businesspartners' AND rp.RecordKey = T0.CardCode
        WHERE T0.CardType = 'C'
          AND T0.validFor = 'Y'
          AND T0.U_AreaCode != ''
          AND (@search IS NULL OR T0.CardCode LIKE @search OR T0.CardName LIKE @search)
          AND (@pushStatus IS NULL OR ISNULL(rp.PushStatus,'Pending') = @pushStatus)
        ORDER BY T0.CardCode
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const summaryQuery = `
        SELECT ISNULL(rp.PushStatus,'Pending') AS PushStatus, COUNT(*) AS Count
        FROM [BBLive].[dbo].OCRD T0
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType = 'businesspartners' AND rp.RecordKey = T0.CardCode
        WHERE T0.CardType='C' AND T0.validFor='Y' AND T0.U_AreaCode != ''
        GROUP BY ISNULL(rp.PushStatus,'Pending')
    `;

    const [dataRes, summaryRes] = await Promise.all([
        pool.request()
            .input('search',     sql.NVarChar(200), searchVal)
            .input('pushStatus', sql.NVarChar(20),  statusVal)
            .input('offset',     sql.Int,           offset)
            .input('limit',      sql.Int,           limit)
            .query(dataQuery),
        pool.request().query(summaryQuery),
    ]);

    const records = dataRes.recordset;
    const total   = records.length > 0 ? records[0].TotalCount : 0;
    const summaryMap = { Pending: 0, Pushing: 0, Pushed: 0, Failed: 0 };
    for (const row of summaryRes.recordset) summaryMap[row.PushStatus] = row.Count;

    return {
        data:       records.map(({ TotalCount, ...rest }) => rest),
        total, page, limit,
        totalPages: Math.ceil(total / limit),
        summary:    summaryMap,
    };
}

async function getBPMasterDataByCodes(cardCodes) {
    if (!cardCodes || cardCodes.length === 0) return [];
    return getBPMasterData(cardCodes);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS PARTNER SCHEDULER TRIGGER — ACRD.U_SFATriggerStatus drives
// one-CardCode-at-a-time processing: NULL/'N' = pending, 'Y' = already synced.
// ─────────────────────────────────────────────────────────────────────────────
async function getNextPendingBPTrigger() {
    const pool = await getPool();

    const result = await pool.request().query(`
        SELECT TOP 1 CardCode, CardName
        FROM ACRD
        WHERE U_SFATriggerStatus IS NULL
           OR U_SFATriggerStatus = 'N'
        ORDER BY CardCode
    `);

    return result.recordset[0] || null;
}

async function markBPTriggerSynced(cardCode) {
    const pool = await getPool();

    await pool.request()
        .input('CardCode', sql.NVarChar(50), cardCode)
        .query(`
            UPDATE ACRD
            SET U_SFATriggerStatus = 'Y'
            WHERE CardCode = @CardCode
        `);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMES — paged list + full data by DocEntry codes
// ─────────────────────────────────────────────────────────────────────────────
async function getSchemesPaged({ page = 1, limit = 50, search, pushStatus } = {}) {
    const pool      = await getPool();
    const offset    = (page - 1) * limit;
    const searchVal = search     ? `%${search}%` : null;
    const statusVal = pushStatus || null;

    const dataQuery = `
        WITH SchemeSummary AS (
            SELECT
                T0.DocEntry,
                CAST(CONCAT(CAST(T0.[Object] AS NVARCHAR(50)), T0.DocNum) AS NVARCHAR(60)) AS PolicyNumber,
                CAST(T0.Remark AS NVARCHAR(500))                      AS PolicyName,
                MAX(CASE
                    WHEN T1.U_bran LIKE '%UATHAYAM%' THEN 'UATHAYAM'
                    WHEN T1.U_bran LIKE '%ARISER%'   THEN 'ARISER'
                    ELSE NULL END)                                    AS DivisionCode,
                MAX(T1.U_Discunt)                                     AS DiscountBasis,
                CONVERT(VARCHAR(10), T0.U_FrmDt, 120)                AS FromDate,
                CONVERT(VARCHAR(10), T0.U_ToDt,  120)                AS ToDate,
                COUNT(DISTINCT T1.LineId)                             AS LineCount
            FROM [BBLive].[dbo]."@SCHEM" T0
            INNER JOIN [BBLive].[dbo]."@SCHEML" T1 ON T0.DocEntry = T1.DocEntry
            WHERE T0.U_FrmDt >= '20250701' AND T0.U_ToDt <= '20260531'
            GROUP BY T0.DocEntry, T0.DocNum, CAST(T0.[Object] AS NVARCHAR(50)), CAST(T0.Remark AS NVARCHAR(500)), T0.U_FrmDt, T0.U_ToDt
        )
        SELECT
            COUNT(*) OVER()                             AS TotalCount,
            ss.DocEntry, ss.PolicyNumber, ss.PolicyName,
            ss.DivisionCode, ss.DiscountBasis,
            ss.FromDate, ss.ToDate, ss.LineCount,
            ISNULL(rp.PushStatus,'Pending')             AS PushStatus,
            rp.LastPushedAt,
            rp.ErrorMessage                             AS PushError
        FROM SchemeSummary ss
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType = 'schemes' AND rp.RecordKey = CAST(ss.DocEntry AS NVARCHAR(100))
        WHERE (@search IS NULL OR ss.PolicyNumber LIKE @search OR ss.PolicyName LIKE @search)
          AND (@pushStatus IS NULL OR ISNULL(rp.PushStatus,'Pending') = @pushStatus)
        ORDER BY ss.DocEntry
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const summaryQuery = `
        SELECT ISNULL(rp.PushStatus,'Pending') AS PushStatus, COUNT(*) AS Count
        FROM (
            SELECT DISTINCT T0.DocEntry
            FROM [BBLive].[dbo]."@SCHEM" T0
            WHERE T0.U_FrmDt >= '20250701' AND T0.U_ToDt <= '20260531'
        ) base
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType='schemes' AND rp.RecordKey=CAST(base.DocEntry AS NVARCHAR(100))
        GROUP BY ISNULL(rp.PushStatus,'Pending')
    `;

    const [dataRes, summaryRes] = await Promise.all([
        pool.request()
            .input('search',     sql.NVarChar(200), searchVal)
            .input('pushStatus', sql.NVarChar(20),  statusVal)
            .input('offset',     sql.Int,           offset)
            .input('limit',      sql.Int,           limit)
            .query(dataQuery),
        pool.request().query(summaryQuery),
    ]);

    const records = dataRes.recordset;
    const total   = records.length > 0 ? records[0].TotalCount : 0;
    const summaryMap = { Pending: 0, Pushing: 0, Pushed: 0, Failed: 0 };
    for (const row of summaryRes.recordset) summaryMap[row.PushStatus] = row.Count;

    return {
        data:       records.map(({ TotalCount, ...rest }) => rest),
        total, page, limit,
        totalPages: Math.ceil(total / limit),
        summary:    summaryMap,
    };
}

async function getSchemeDataByCodes(docEntries) {
    if (!docEntries || docEntries.length === 0) return [];
    const pool = await getPool();
    const req  = pool.request();
    const placeholders = docEntries.map((c, i) => { req.input(`c${i}`, sql.Int, Number(c)); return `@c${i}`; }).join(',');

    const query = `
        SELECT
            CAST(CONCAT(T0.[Object], T0.DocNum) AS NVARCHAR(50)) AS PolicyNumber,
            1 AS Revision,
            T0.DocEntry AS PolicyID,
            T0.Remark AS PolicyName,
            CASE WHEN T1.U_Discunt='Quantity' THEN 'SC' WHEN T1.U_Discunt='Percentage' THEN 'DIS' END AS SavingType,
            T1.U_Discunt AS DiscountBasis,
            'P' AS Applicability,
            1 AS IsCustomerDefined, 1 AS IsActive,
            CASE
                WHEN T1.U_bran='UATHAYAM DHOTIE'     THEN 'UATHAYAM'
                WHEN T1.U_bran='UATHAYAM SHIRTING'   THEN 'UATHAYAM'
                WHEN T1.U_bran='UATHAYAM RDY'        THEN 'UATHAYAM'
                WHEN T1.U_bran='UATHAYAM HOS'        THEN 'UATHAYAM'
                WHEN T1.U_bran='UATHAYAM KIDS SET'   THEN 'UATHAYAM'
                WHEN T1.U_bran='UATHAYAM MENS SET'   THEN 'UATHAYAM'
                WHEN T1.U_bran='ARISER SHIRT'        THEN 'ARISER'
                WHEN T1.U_bran='ARISER MENS TROUSERS' THEN 'ARISER'
                WHEN T1.U_bran='ARISER KNITS'          THEN 'ARISER'
            END AS DivisionCode,
            '2026-05-20T00:00:00' AS FromDate, '2026-07-01T00:00:00' AS ToDate,
            0 AS AllowDiscountForAllProducts, NULL AS DiscountPer,
            (SELECT 'DEALER' AS BPCategory FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_BpCategoryMapping,
            (SELECT DISTINCT L.U_Stat AS StateCode FROM [BBLive].[dbo]."@SCHEML" L
             WHERE L.DocEntry=T0.DocEntry AND L.U_Stat IS NOT NULL
             FOR JSON PATH, INCLUDE_NULL_VALUES) AS StateMapping,
            (SELECT 'DEALER' AS Role FOR JSON PATH, INCLUDE_NULL_VALUES) AS RoleMapping,
            (SELECT NULL AS BPCode FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_BpExclution,
            (SELECT DISTINCT C.CardCode AS BPCode FROM [BBLive].[dbo].OCRD C
             INNER JOIN [BBLive].[dbo].CRD1 D ON C.CardCode=D.CardCode AND D.AdresType='B'
             WHERE D.State IN (SELECT DISTINCT L.U_Stat FROM [BBLive].[dbo]."@SCHEML" L WHERE L.DocEntry=T0.DocEntry)
             FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_BpInclution,
            (SELECT I.ItemCode AS ProductCode, I.U_Size AS SizeCode, I.U_SubGrp6 AS ColorCode,
                CAST(L.U_BillsQty AS DECIMAL(10,2)) AS MinOrderQty,
                CAST(L.U_OffersQty AS DECIMAL(10,2)) AS FreeQty,
                'S' AS Applicability, L.U_OffersQty AS AllowMultiplyFreeQty,
                CAST(L.U_BillsQty AS DECIMAL(10,2)) AS MaxAllowedFreeQty,
                1 AS IsActive, 1 AS MappingStatus,
                (SELECT ALT.ItemCode AS ProductCode, ALT.U_Size AS SizeCode, ALT.U_SubGrp6 AS ColorCode, 0 AS IsActive
                 FROM [BBLive].[dbo].OITM ALT WHERE ALT.ItemCode=I.ItemCode AND ALT.validFor='Y'
                 FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_ProdAlternate
             FROM [BBLive].[dbo]."@SCHEML" L
             INNER JOIN [BBLive].[dbo].OITM I ON I.U_SubGrp7=L.U_Qual
             WHERE L.DocEntry=T0.DocEntry FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_ProductMapping,
            (SELECT NULL AS GroupCode, NULL AS StyleCode, NULL AS MinOrderQty, NULL AS FreeQty,
                NULL AS Applicability, 0 AS AllowMultiplyFreeQty, NULL AS MaxAllowedFreeQty,
                NULL AS GroupName, 0 AS IsActive, 0 AS MappingStatus
             FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_ProdGroupMapping,
            (SELECT NULL AS ProductCode, NULL AS SizeCode, NULL AS ColorCode, 0 AS IsActive
             FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_ProdAlternate,
            (SELECT NULL AS GroupName, NULL AS StyleCode, 0 AS IsActive FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_ProdGroupAlternate,
            (SELECT NULL AS Brand, NULL AS DiscountType, NULL AS DiscountVal, 0 AS IsActive FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_Brand_Discount,
            (SELECT NULL AS DivisionCode, NULL AS GroupCode, NULL AS GroupName, NULL AS StyleCode,
                NULL AS StyleName, NULL AS DiscountType, NULL AS DiscountVal, 0 AS IsActive
             FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_ProdGroupDirectDiscount,
            (SELECT NULL AS ProductCode, NULL AS SizeCode, NULL AS ColorCode,
                NULL AS DiscountType, NULL AS DiscountVal, 0 AS IsActive
             FOR JSON PATH, INCLUDE_NULL_VALUES) AS SC_ProductDirectDiscount
        FROM [BBLive].[dbo]."@SCHEM" T0
        INNER JOIN [BBLive].[dbo]."@SCHEML" T1 ON T0.DocEntry = T1.DocEntry
        WHERE T0.DocEntry IN (${placeholders})
    `;
    const result = await req.query(query);
    return result.recordset;
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK INVENTORY — paged list + full data by codes
// ─────────────────────────────────────────────────────────────────────────────
async function getStockPaged({ page = 1, limit = 50, search, pushStatus } = {}) {
    const pool      = await getPool();
    const offset    = (page - 1) * limit;
    const searchVal = search     ? `%${search}%` : null;
    const statusVal = pushStatus || null;

    const dataQuery = `
        WITH StockSummary AS (
            SELECT
                t0.ItemCode  AS ProductCode,
                t0.ItemName  AS ProductName,
                t0.U_SubGrp4 AS StyleCode,
                t0.U_SubGrp1 AS Brand,
                CAST(SUM(t1.OnHand) AS INT) AS StockQuantity
            FROM [BBLive].[dbo].OITM t0
            INNER JOIN [BBLive].[dbo].OITW t1 ON t0.ItemCode = t1.ItemCode
            WHERE t1.WhsCode = 'ASRS' AND t0.ValidFor = 'Y'
            GROUP BY t0.ItemCode, t0.ItemName, t0.U_SubGrp4, t0.U_SubGrp1
        )
        SELECT
            COUNT(*) OVER()                             AS TotalCount,
            ss.ProductCode, ss.ProductName, ss.StyleCode, ss.Brand, ss.StockQuantity,
            ISNULL(rp.PushStatus,'Pending')             AS PushStatus,
            rp.LastPushedAt,
            rp.ErrorMessage                             AS PushError
        FROM StockSummary ss
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType = 'stockInventory' AND rp.RecordKey = ss.ProductCode
        WHERE (@search IS NULL OR ss.ProductCode LIKE @search OR ss.ProductName LIKE @search)
          AND (@pushStatus IS NULL OR ISNULL(rp.PushStatus,'Pending') = @pushStatus)
        ORDER BY ss.ProductCode
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const summaryQuery = `
        SELECT ISNULL(rp.PushStatus,'Pending') AS PushStatus, COUNT(*) AS Count
        FROM (
            SELECT DISTINCT t0.ItemCode
            FROM [BBLive].[dbo].OITM t0
            INNER JOIN [BBLive].[dbo].OITW t1 ON t0.ItemCode=t1.ItemCode
            WHERE t1.WhsCode='ASRS' AND t0.ValidFor='Y'
        ) base
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType='stockInventory' AND rp.RecordKey=base.ItemCode
        GROUP BY ISNULL(rp.PushStatus,'Pending')
    `;

    const [dataRes, summaryRes] = await Promise.all([
        pool.request()
            .input('search',     sql.NVarChar(200), searchVal)
            .input('pushStatus', sql.NVarChar(20),  statusVal)
            .input('offset',     sql.Int,           offset)
            .input('limit',      sql.Int,           limit)
            .query(dataQuery),
        pool.request().query(summaryQuery),
    ]);

    const records = dataRes.recordset;
    const total   = records.length > 0 ? records[0].TotalCount : 0;
    const summaryMap = { Pending: 0, Pushing: 0, Pushed: 0, Failed: 0 };
    for (const row of summaryRes.recordset) summaryMap[row.PushStatus] = row.Count;

    return {
        data:       records.map(({ TotalCount, ...rest }) => rest),
        total, page, limit,
        totalPages: Math.ceil(total / limit),
        summary:    summaryMap,
    };
}

async function getStockDataByCodes(itemCodes) {
    if (!itemCodes || itemCodes.length === 0) return [];
    const pool = await getPool();
    const req  = pool.request();
    const placeholders = itemCodes.map((c, i) => { req.input(`c${i}`, sql.NVarChar(50), c); return `@c${i}`; }).join(',');

    const query = `
        SELECT
            t0.DocEntry                                                AS ExternalId,
            t0.DocEntry                                                AS ProductMappingId,
            t0.ItemCode                                                AS ProductCode,
            t0.U_SubGrp13                                              AS ColorCode,
            t0.U_SubGrp7                                               AS AttributeValue,
            t0.U_SubGrp4                                               AS StyleCode,
            t0.U_Size                                                  AS Size,
            CAST(t1.OnHand AS INT)                                     AS StockQuantity,
            'Stock'                                                    AS Type,
            CASE WHEN t0.ValidFor='Y' THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS IsActive,
            CASE WHEN t0.MinLevel > t1.OnHand THEN 'High Stock' ELSE 'Low Stock' END AS StockHighlightMessageDetails,
            CASE WHEN CAST(t0.MinLevel AS INT) > CAST(t1.OnHand AS INT) THEN 'Very few stock left' ELSE 'Stock Available' END AS StockMessage
        FROM [BBLive].[dbo].OITM AS t0
        INNER JOIN [BBLive].[dbo].OITW AS t1 ON t0.ItemCode = t1.ItemCode
        WHERE t1.WhsCode = 'ASRS'
          AND t0.ValidFor = 'Y'
          AND t0.ItemCode IN (${placeholders})
        ORDER BY t0.ItemCode
    `;
    const result = await req.query(query);
    return result.recordset;
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTSTANDING / RECEIVABLES — paged list + full data by CardCode
// ─────────────────────────────────────────────────────────────────────────────
async function getOutstandingPaged({ page = 1, limit = 50, search, pushStatus } = {}) {
    const pool      = await getPool();
    const offset    = (page - 1) * limit;
    const searchVal = search     ? `%${search}%` : null;
    const statusVal = pushStatus || null;

    const dataQuery = `
        WITH BaseData AS (
            SELECT
                k.CardCode, k.CardName,
                lk.City, lk.State,
                CASE WHEN tk.U_Brand LIKE '%UATHAYAM%' THEN 'UATHAYAM' ELSE 'ARISER' END AS DivisionCode,
                k.BalDueDeb AS BalanceToBePaid,
                CASE WHEN k.BalDueDeb > 0 THEN DATEDIFF(d, k.duedat, GETDATE()) ELSE 0 END AS OverdueDays
            FROM (
                SELECT T2.CardCode, T2.CardName, T1.BalDueDeb, T1.Ref1, T0.TransId,
                    CASE WHEN T1.TransType IN ('-2','30') THEN T1.DueDate ELSE T0.RefDate END AS duedat,
                    T0.TransType
                FROM [BBLive].[dbo].OJDT T0
                INNER JOIN [BBLive].[dbo].JDT1 T1 ON T0.TransId=T1.TransId
                INNER JOIN [BBLive].[dbo].OCRD T2 ON T2.CardCode=T1.ShortName
                INNER JOIN [BBLive].[dbo].OCRG T3 ON T2.GroupCode=T3.GroupCode
                WHERE T1.BalDueDeb<>'0' AND T2.CardType='C'
            ) k
            LEFT JOIN (
                SELECT tl.DocNum, tl.CardCode, tl.U_Brand, tl.TransId
                FROM [BBLive].[dbo].OINV tl
                LEFT JOIN [BBLive].[dbo].[@INCM_BND1] tg ON tg.U_Name=RTRIM(tl.U_Brand)
            ) tk ON CONVERT(NVARCHAR(20),tk.DocNum)=k.Ref1 AND tk.CardCode=k.CardCode AND tk.TransId=k.TransId
            LEFT JOIN (
                SELECT cr1.CardCode, cr2.City, cr2.State
                FROM [BBLive].[dbo].OCRD cr1
                LEFT JOIN [BBLive].[dbo].CRD1 cr2 ON cr2.CardCode=cr1.CardCode AND cr2.AdresType='B'
            ) lk ON lk.CardCode=k.CardCode
        ),
        OutstandingSummary AS (
            SELECT
                CardCode,
                MAX(CardName)          AS CardName,
                MAX(City)              AS City,
                MAX(State)             AS State,
                MAX(DivisionCode)      AS DivisionCode,
                COUNT(*)               AS InvoiceCount,
                SUM(BalanceToBePaid)   AS TotalBalance,
                MAX(OverdueDays)       AS MaxOverdueDays
            FROM BaseData
            GROUP BY CardCode
        )
        SELECT
            COUNT(*) OVER()                             AS TotalCount,
            os.CardCode, os.CardName, os.City, os.State,
            os.DivisionCode, os.InvoiceCount,
            os.TotalBalance, os.MaxOverdueDays,
            ISNULL(rp.PushStatus,'Pending')             AS PushStatus,
            rp.LastPushedAt,
            rp.ErrorMessage                             AS PushError
        FROM OutstandingSummary os
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType='outstanding' AND rp.RecordKey=os.CardCode
        WHERE (@search IS NULL OR os.CardCode LIKE @search OR os.CardName LIKE @search)
          AND (@pushStatus IS NULL OR ISNULL(rp.PushStatus,'Pending') = @pushStatus)
        ORDER BY os.CardCode
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const summaryQuery = `
        WITH BaseData AS (
            SELECT DISTINCT k.CardCode
            FROM (
                SELECT T2.CardCode, T1.BalDueDeb
                FROM [BBLive].[dbo].OJDT T0
                INNER JOIN [BBLive].[dbo].JDT1 T1 ON T0.TransId=T1.TransId
                INNER JOIN [BBLive].[dbo].OCRD T2 ON T2.CardCode=T1.ShortName
                INNER JOIN [BBLive].[dbo].OCRG T3 ON T2.GroupCode=T3.GroupCode
                WHERE T1.BalDueDeb<>'0' AND T2.CardType='C'
            ) k
        )
        SELECT ISNULL(rp.PushStatus,'Pending') AS PushStatus, COUNT(*) AS Count
        FROM BaseData b
        LEFT JOIN [BBLive].[dbo].[SFA_RecordPushStatus] rp
            ON rp.MasterType='outstanding' AND rp.RecordKey=b.CardCode
        GROUP BY ISNULL(rp.PushStatus,'Pending')
    `;

    const [dataRes, summaryRes] = await Promise.all([
        pool.request()
            .input('search',     sql.NVarChar(200), searchVal)
            .input('pushStatus', sql.NVarChar(20),  statusVal)
            .input('offset',     sql.Int,           offset)
            .input('limit',      sql.Int,           limit)
            .query(dataQuery),
        pool.request().query(summaryQuery),
    ]);

    const records = dataRes.recordset;
    const total   = records.length > 0 ? records[0].TotalCount : 0;
    const summaryMap = { Pending: 0, Pushing: 0, Pushed: 0, Failed: 0 };
    for (const row of summaryRes.recordset) summaryMap[row.PushStatus] = row.Count;

    return {
        data:       records.map(({ TotalCount, ...rest }) => rest),
        total, page, limit,
        totalPages: Math.ceil(total / limit),
        summary:    summaryMap,
    };
}

async function getOutstandingDataByCodes(cardCodes) {
    if (!cardCodes || cardCodes.length === 0) return [];
    const pool = await getPool();
    const req  = pool.request();
    const placeholders = cardCodes.map((c, i) => { req.input(`c${i}`, sql.NVarChar(50), c); return `@c${i}`; }).join(',');

    const query = `
        SELECT
            CASE WHEN tk.U_Brand LIKE '%UATHAYAM%' THEN 'UATHAYAM' ELSE 'ARISER' END AS DivisionCode,
            CAST(tk.DocEntry AS NVARCHAR(20)) AS DocEntry,
            CASE WHEN tk.U_Brand LIKE '%UATHAYAM%' THEN 'UATHAYAM' ELSE 'ARISER' END AS DivisionName,
            tk.U_Brand AS Brand,
            CASE WHEN k.TransType='13' THEN 'AR Invoice' WHEN k.TransType='30' THEN 'Journal' ELSE NULL END AS DocType,
            CASE WHEN k.Ref1 NOT LIKE '%[^0-9]%' AND k.Ref1 IS NOT NULL THEN CAST(k.Ref1 AS INT) ELSE NULL END AS InvoiceNo,
            tk.DocDate AS InvoiceDate,
            k.duedat AS DueDate,
            k.CardCode, k.CardName,
            lk.City, lk.State,
            k.memo AS DocumentRemarks,
            CASE WHEN k.BalDueDeb>0 THEN DATEDIFF(d,k.duedat,GETDATE()) ELSE 0 END AS OverdueDays,
            GETDATE() AS OverdueDate,
            CASE WHEN k.TransType='30' THEN k.Debit ELSE ISNULL(tk.DocTotal,0) END AS DocumentValue,
            k.BalDueDeb AS BalanceToBePaid,
            CAST(0 AS BIT) AS BatchEnd
        FROM (
            SELECT T2.CardCode, T2.CardName, T0.RefDate, T1.BaseRef, T1.Debit, T1.Credit,
                T0.TransId, T1.BalDueDeb, T1.LineMemo, T2.MailCity, T3.GroupName, T1.Ref1,
                CASE WHEN T1.TransType IN ('-2','30') THEN T1.DueDate ELSE T0.RefDate END AS duedat,
                T1.OcrCode3 AS brand, T0.memo, T0.TransType
            FROM [BBLive].[dbo].OJDT T0
            INNER JOIN [BBLive].[dbo].JDT1 T1 ON T0.TransId=T1.TransId
            INNER JOIN [BBLive].[dbo].OCRD T2 ON T2.CardCode=T1.ShortName
            INNER JOIN [BBLive].[dbo].OCRG T3 ON T2.GroupCode=T3.GroupCode
            WHERE T1.BalDueDeb<>'0' AND T2.CardType='C'
              AND T2.CardCode IN (${placeholders})
        ) k
        LEFT JOIN (
            SELECT tl.DocNum, tl.DocEntry, tl.DocDate, tl.DocTotal, tl.CardCode, tl.U_Brand, tg.U_Remarks, tl.TransId
            FROM [BBLive].[dbo].OINV tl
            LEFT JOIN [BBLive].[dbo].[@INCM_BND1] tg ON tg.U_Name=RTRIM(tl.U_Brand)
        ) tk ON CONVERT(NVARCHAR(20),tk.DocNum)=k.Ref1 AND tk.CardCode=k.CardCode AND tk.TransId=k.TransId
        LEFT JOIN (
            SELECT cr1.CardCode, cr2.City, cr2.State
            FROM [BBLive].[dbo].OCRD cr1
            LEFT JOIN [BBLive].[dbo].CRD1 cr2 ON cr2.CardCode=cr1.CardCode AND cr2.AdresType='B'
        ) lk ON lk.CardCode=k.CardCode
    `;
    const result = await req.query(query);
    return result.recordset;
}

/**
 * Insert a single punch log record.
 * Returns { skipped: true } if a record already exists for the same date, EmployeeId, and PunchType,
 * otherwise { inserted: true }.
 */
async function insertPunchLog({ RefId, EmployeeId, PunchType, PunchTime }) {
    const pool = await getPool();

    const dupResult = await pool.request()
        .input('EmployeeIdChk', sql.VarChar(20),      EmployeeId)
        .input('PunchTypeChk',  sql.Char(1),           PunchType)
        .input('PunchTimeChk',  sql.DateTime2(7),      new Date(PunchTime))
        .query(`
            SELECT 1 AS found FROM [BBLive].[dbo].[ehr_punch_log]
            WHERE EmployeeId = @EmployeeIdChk
              AND PunchType  = @PunchTypeChk
              AND CAST(PunchTime AS DATE) = CAST(@PunchTimeChk AS DATE)
        `);

    if (dupResult.recordset.length > 0) {
        return { skipped: true };
    }

    await pool.request()
        .input('RefId',           sql.VarChar(sql.MAX), RefId)
        .input('EmployeeId',      sql.VarChar(20),       EmployeeId)
        .input('PunchType',       sql.Char(1),           PunchType)
        .input('PunchTime',       sql.DateTime2(7),      new Date(PunchTime))
        .query(`
            INSERT INTO [BBLive].[dbo].[ehr_punch_log]
                (RefId, EmployeeId, PunchType, PunchTime, CaptureDateTime, PushStatus)
            VALUES
                (@RefId, @EmployeeId, @PunchType, @PunchTime, GETDATE(), 'Pending')
        `);

    return { inserted: true };
}

async function updatePunchLogStatus(RefId, status) {
    const pool = await getPool();
    await pool.request()
        .input('RefId',  sql.VarChar(sql.MAX), RefId)
        .input('Status', sql.VarChar(20),       status)
        .query(`UPDATE [BBLive].[dbo].[ehr_punch_log] SET PushStatus = @Status WHERE RefId = @RefId`);
}

/** Fetch all Pending records for a given PunchType ('I' or 'O'). */
async function getPendingPunchLogs(punchType) {
    const pool = await getPool();
    const result = await pool.request()
        .input('PunchType', sql.Char(1), punchType)
        .query(`
            SELECT Id, RefId, EmployeeId, PunchType, PunchTime, CaptureDateTime
            FROM [BBLive].[dbo].[ehr_punch_log]
            WHERE PunchType  = @PunchType
              AND (PushStatus = 'Pending' OR PushStatus = 'Failed')
            ORDER BY PunchTime ASC
        `);
    return result.recordset;
}

/** Bulk-update PushStatus for a list of Ids (BIGINT primary keys). */
async function updatePunchLogStatusByIds(ids, status) {
    if (!ids || ids.length === 0) return;
    const pool = await getPool();
    const req  = pool.request();
    req.input('Status', sql.VarChar(20), status);
    const placeholders = ids.map((id, i) => {
        req.input(`id${i}`, sql.BigInt, id);
        return `@id${i}`;
    }).join(', ');
    await req.query(
        `UPDATE [BBLive].[dbo].[ehr_punch_log] SET PushStatus = @Status WHERE Id IN (${placeholders})`
    );
}

async function getEhrLogsPaged({ page = 1, limit = 50, search, punchType, pushStatus, dateFrom, dateTo } = {}) {
    const pool      = await getPool();
    const offset    = (page - 1) * limit;
    const searchVal = search     ? `%${search}%` : null;
    const typeVal   = punchType  || null;
    const statusVal = pushStatus || null;
    const fromVal   = dateFrom   || null;
    const toVal     = dateTo     || null;

    const dataQuery = `
        SELECT
            COUNT(*) OVER() AS TotalCount,
            Id, RefId, EmployeeId, PunchType, PunchTime, CaptureDateTime, PushStatus
        FROM [BBLive].[dbo].[ehr_punch_log]
        WHERE (@search     IS NULL OR EmployeeId LIKE @search OR RefId LIKE @search)
          AND (@punchType  IS NULL OR PunchType  = @punchType)
          AND (@pushStatus IS NULL OR PushStatus = @pushStatus)
          AND (@dateFrom   IS NULL OR CAST(PunchTime AS DATE) >= @dateFrom)
          AND (@dateTo     IS NULL OR CAST(PunchTime AS DATE) <= @dateTo)
        ORDER BY Id DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const statsQuery = `
        SELECT PunchType, PushStatus, COUNT(*) AS Count
        FROM [BBLive].[dbo].[ehr_punch_log]
        GROUP BY PunchType, PushStatus
    `;

    const [dataRes, statsRes] = await Promise.all([
        pool.request()
            .input('search',     sql.NVarChar(200), searchVal)
            .input('punchType',  sql.Char(1),       typeVal)
            .input('pushStatus', sql.NVarChar(20),  statusVal)
            .input('dateFrom',   sql.Date,          fromVal ? new Date(fromVal) : null)
            .input('dateTo',     sql.Date,          toVal   ? new Date(toVal)   : null)
            .input('offset',     sql.Int,           offset)
            .input('limit',      sql.Int,           limit)
            .query(dataQuery),
        pool.request().query(statsQuery),
    ]);

    const records = dataRes.recordset;
    const total   = records.length > 0 ? records[0].TotalCount : 0;

    const stats = {
        checkin:  { Pending: 0, Pushed: 0, Failed: 0, total: 0 },
        checkout: { Pending: 0, Pushed: 0, Failed: 0, total: 0 },
    };
    for (const row of statsRes.recordset) {
        const key = row.PunchType === 'I' ? 'checkin' : 'checkout';
        if (stats[key][row.PushStatus] !== undefined) stats[key][row.PushStatus] = row.Count;
        stats[key].total += row.Count;
    }

    return {
        data:       records.map(({ TotalCount, ...rest }) => rest),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        stats,
    };
}

async function getPunchLogById(id) {
    const pool = await getPool();
    const result = await pool.request()
        .input('Id', sql.BigInt, id)
        .query(`
            SELECT Id, RefId, EmployeeId, PunchType, PunchTime, CaptureDateTime, PushStatus
            FROM [BBLive].[dbo].[ehr_punch_log]
            WHERE Id = @Id
        `);
    return result.recordset[0] || null;
}

/**
 * Upsert one row per JobKey in SFA_EhrJobLog.
 * Call with status='Running' on trigger start, 'Completed'/'Failed' on finish.
 *
 * DDL (run once):
 *   CREATE TABLE [BBLive].[dbo].[SFA_EhrJobLog] (
 *       JobKey          VARCHAR(50) NOT NULL PRIMARY KEY,
 *       PunchType       CHAR(1)     NOT NULL,
 *       LastTriggeredAt DATETIME    NOT NULL,
 *       LastCompletedAt DATETIME    NULL,
 *       LastStatus      VARCHAR(20) NOT NULL,
 *       UpdatedAt       DATETIME    NOT NULL
 *   );
 */
async function upsertEhrTriggerLog(jobKey, punchType, triggeredAt, status, completedAt = null) {
    const pool = await getPool();
    await pool.request()
        .input('JobKey',          sql.VarChar(50),  jobKey)
        .input('PunchType',       sql.Char(1),      punchType)
        .input('LastTriggeredAt', sql.DateTime,     triggeredAt)
        .input('LastCompletedAt', sql.DateTime,     completedAt)
        .input('LastStatus',      sql.VarChar(20),  status)
        .input('UpdatedAt',       sql.DateTime,     new Date())
        .query(`
            MERGE [BBLive].[dbo].[SFA_EhrJobLog] AS T
            USING (SELECT @JobKey AS JobKey) AS S ON T.JobKey = S.JobKey
            WHEN MATCHED THEN
                UPDATE SET
                    LastTriggeredAt = @LastTriggeredAt,
                    LastCompletedAt = @LastCompletedAt,
                    LastStatus      = @LastStatus,
                    UpdatedAt       = @UpdatedAt
            WHEN NOT MATCHED THEN
                INSERT (JobKey, PunchType, LastTriggeredAt, LastCompletedAt, LastStatus, UpdatedAt)
                VALUES (@JobKey, @PunchType, @LastTriggeredAt, @LastCompletedAt, @LastStatus, GETDATE());
        `);
}

module.exports = {
    getProductData,
    getProductsPaged,
    getProductGroups,
    getProductDataByCodes,
    getPriceListRowsPaged,
    getPriceListStates,
    getNextPendingProductTrigger,
    markProductTriggerSynced,
    getPriceListData,
    getPriceListsPaged,
    getPriceListDataByCodes,
    getImageData,
    getSchemeData,
    getSchemesPaged,
    getSchemeDataByCodes,
    getBPMasterData,
    getBPListPaged,
    getBPMasterDataByCodes,
    getNextPendingBPTrigger,
    markBPTriggerSynced,
    getStockData,
    getStockPaged,
    getStockDataByCodes,
    getOutstandingData,
    getOutstandingPaged,
    getOutstandingDataByCodes,
    insertPunchLog,
    updatePunchLogStatus,
    getPendingPunchLogs,
    updatePunchLogStatusByIds,
    getEhrLogsPaged,
    getPunchLogById,
    upsertEhrTriggerLog,
};

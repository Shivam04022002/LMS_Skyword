import OneBulkImport from '../../components/oneBulk/OneBulkImport';

/*
 * TEMPORARY: oneBulk historical collection migration utility.
 * Can be removed after historical collections are migrated — delete this
 * file, `src/components/oneBulk/`, `services/oneBulkService.js`, and the
 * route plus nav entry in `routes/AppRoutes.jsx` and `routes/navigation.js`
 * that point here. Nothing else references this page.
 */
export default function OneBulkImportPage() {
  return <OneBulkImport />;
}

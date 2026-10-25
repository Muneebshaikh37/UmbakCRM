import { type AllMetadataName } from 'twenty-shared/metadata';

import {
  type ALL_ENTITY_PROPERTIES_CONFIGURATION_BY_METADATA_NAME,
  type MetadataEntityDivergenceReportedPropertyName,
} from 'src/engine/metadata-modules/flat-entity/constant/all-entity-properties-configuration-by-metadata-name.constant';
import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';
import { type ExtractUniversalPropertyName } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/extract-universal-property-name.type';

export type MetadataUniversalFlatEntityPropertiesToReportDivergence<
  T extends AllMetadataName,
  MetadataConfig =
    (typeof ALL_ENTITY_PROPERTIES_CONFIGURATION_BY_METADATA_NAME)[T],
  TDivergenceReportedKeys extends keyof MetadataConfig =
    MetadataEntityDivergenceReportedPropertyName<T> & keyof MetadataConfig,
> = {
  [P in TDivergenceReportedKeys]: ExtractUniversalPropertyName<
    MetadataConfig,
    P
  >;
}[TDivergenceReportedKeys] &
  keyof MetadataUniversalFlatEntity<T>;

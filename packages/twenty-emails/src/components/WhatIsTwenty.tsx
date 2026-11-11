import { type I18n } from '@lingui/core';
import { MainText } from 'src/components/MainText';
import { SubTitle } from 'src/components/SubTitle';

type WhatIsTwentyProps = {
  i18n: I18n;
};

export const WhatIsTwenty = ({ i18n }: WhatIsTwentyProps) => {
  return (
    <>
      <SubTitle value={i18n._('What is UmbakCRM?')} />
      <MainText>
        {i18n._(
          "It's a CRM built by Irish Payments to help businesses manage their customer data and relationships efficiently.",
        )}
      </MainText>
    </>
  );
};

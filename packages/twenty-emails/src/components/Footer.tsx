import { type I18n } from '@lingui/core';
import { Column, Container, Row } from 'react-email';
import { Link } from 'src/components/Link';
import { ShadowText } from 'src/components/ShadowText';

const footerContainerStyle = {
  marginTop: '12px',
};

type FooterProps = {
  i18n: I18n;
};

export const Footer = ({ i18n }: FooterProps) => {
  return (
    <Container style={footerContainerStyle}>
      <Row>
        <Column>
          <ShadowText>
            <Link
              href="https://irishpayments.ie/"
              value={i18n._('Website')}
              aria-label={i18n._("Visit Irish Payments website")}
            />
          </ShadowText>
        </Column>
        <Column>
          <ShadowText>
            <Link
              href="https://irishpayments.ie/"
              value={i18n._('Contact')}
              aria-label={i18n._("Contact Irish Payments")}
            />
          </ShadowText>
        </Column>
        <Column>
          <ShadowText>
            <Link
              href="https://crm.irishpayments.ie/"
              value={i18n._('CRM')}
              aria-label={i18n._("Open UmbakCRM")}
            />
          </ShadowText>
        </Column>
        <Column>
          <ShadowText>
            <Link
              href="https://irishpayments.ie/"
              value={i18n._('Support')}
              aria-label={i18n._("Get support from Irish Payments")}
            />
          </ShadowText>
        </Column>
      </Row>
      <ShadowText>
        <>
          {i18n._('Irish Payments Ltd')}
          <br />
          {i18n._('Ireland')}
        </>
      </ShadowText>
    </Container>
  );
};

// Pronunciation test set (stage C, item 15 of the spec). `pron` is the standard pronunciation.
export interface TestItem {
  id: string;
  text: string;
  cat: string;
  pron?: string;
}

export const TEST_SET: TestItem[] = [
  { id: 'silla', text: '신라', cat: 'ассимиляция', pron: '[실라]' },
  { id: 'ikda', text: '읽다', cat: '받침 ㄺ', pron: '[익따]' },
  { id: 'gachi', text: '같이', cat: 'палатализация', pron: '[가치]' },
  { id: 'hangugeo', text: '한국어', cat: 'связывание', pron: '[한구거]' },
  { id: 'kkochi', text: '꽃이', cat: 'частица после 받침', pron: '[꼬치]' },
  { id: 'uisa', text: '의사', cat: 'ㅢ', pron: '[의사]' },
  { id: 'joayo', text: '좋아요', cat: 'естественность', pron: '[조아요]' },
  { id: 'gwaenchanayo', text: '괜찮아요', cat: 'плавность', pron: '[괜차나요]' },
  { id: 'mul', text: '물', cat: 'короткое' },
  { id: 'nun', text: '눈', cat: 'короткое' },
  { id: 'chaek', text: '책', cat: 'короткое' },
  { id: 'gukjegonghang', text: '국제공항', cat: 'длинное', pron: '[국쩨공항]' },
  { id: 'daehanminguk', text: '대한민국', cat: 'длинное' },
  { id: 'areubaiteu', text: '아르바이트생', cat: 'длинное, заимствование' },
  { id: 'num_year', text: '2026년', cat: 'число' },
  { id: 'num_time', text: '3시 15분이에요.', cat: 'число' },
  { id: 'num_age', text: '저는 스물다섯 살이에요.', cat: 'число словами' },
  { id: 'num_price', text: '만 원이에요.', cat: 'число словами' },
  { id: 'computer', text: '컴퓨터', cat: 'заимствование' },
  { id: 'icecream', text: '아이스크림', cat: 'заимствование' },
  { id: 'smartphone', text: '스마트폰', cat: 'заимствование' },
  { id: 'coffee', text: '커피 한 잔 주세요.', cat: 'заимствование в предложении' },
  { id: 'q_where', text: '어디에 가요?', cat: 'вопрос' },
  { id: 'q_price', text: '이거 얼마예요?', cat: 'вопрос' },
  { id: 'stmt_ate', text: '밥 먹었어요.', cat: 'утверждение' },
  { id: 'q_ate', text: '밥 먹었어요?', cat: 'вопрос (сравнить с утверждением)' },
  { id: 'excl', text: '정말 맛있어요!', cat: 'восклицание' },
  { id: 'polite_long', text: '처음 뵙겠습니다. 저는 러시아에서 온 학생이고, 한국어를 공부하고 있습니다.', cat: 'длинное предложение' },
  { id: 'hello', text: '안녕하세요, 만나서 반갑습니다.', cat: 'фраза' },
  { id: 'school', text: '내일 친구랑 같이 학교에 갈 거예요.', cat: 'фраза' },
];
